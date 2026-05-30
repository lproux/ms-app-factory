import { randomUUID } from 'node:crypto';
import type { TokenCredential } from '@azure/identity';
import { AuthorizationManagementClient } from '@azure/arm-authorization';
import { AppFactoryError, ProvisioningError, createLogger } from '@app-factory/shared';
import { createGraphClient, type GraphClient } from './graph.js';

const log = createLogger('azure-ops:sp');

const CONTRIBUTOR_ROLE_DEF_ID = 'b24988ac-6180-42a0-ab88-20f7382dd24c';
const CLOUD_APP_ADMIN_TEMPLATE_ID = '158c047a-c907-4556-b7ef-446551a6b5f7';

export interface ServicePrincipalCreated {
  appId: string;
  objectId: string;
  secret: string;
  password: string;
  secretExpiry: string;
}

interface CreateSpOptions {
  displayName: string;
  tenantId: string;
  graph?: GraphClient;
}

interface AppCreateResponse {
  id: string;
  appId: string;
  displayName: string;
}

interface SpCreateResponse {
  id: string;
  appId: string;
  displayName: string;
}

interface AddPasswordResponse {
  secretText: string;
  endDateTime: string;
}

export async function createServicePrincipal(
  cred: TokenCredential,
  opts: CreateSpOptions,
): Promise<ServicePrincipalCreated> {
  const graph = opts.graph ?? createGraphClient(cred);

  const app = await graph.request<AppCreateResponse>('POST', '/applications', {
    displayName: opts.displayName,
    signInAudience: 'AzureADMyOrg',
  });

  const sp = await graph.request<SpCreateResponse>('POST', '/servicePrincipals', {
    appId: app.appId,
  });

  const password = await graph.request<AddPasswordResponse>(
    'POST',
    `/applications/${app.id}/addPassword`,
    {
      passwordCredential: {
        displayName: `app-factory-${new Date().toISOString().slice(0, 10)}`,
      },
    },
  );

  log.info(
    { appId: app.appId, objectId: sp.id, displayName: opts.displayName },
    'service principal created',
  );

  return {
    appId: app.appId,
    objectId: sp.id,
    secret: password.secretText,
    password: password.secretText,
    secretExpiry: password.endDateTime,
  };
}

export interface AssignContributorOptions {
  subId: string;
  rgName: string;
  principalObjectId: string;
}

export async function assignContributorOnResourceGroup(
  cred: TokenCredential,
  opts: AssignContributorOptions,
): Promise<{ id: string; created: boolean }> {
  const scope = `/subscriptions/${opts.subId}/resourceGroups/${opts.rgName}`;
  const client = new AuthorizationManagementClient(cred, opts.subId);
  const roleDefinitionId = `/subscriptions/${opts.subId}/providers/Microsoft.Authorization/roleDefinitions/${CONTRIBUTOR_ROLE_DEF_ID}`;
  const assignmentName = randomUUID();

  try {
    const result = await client.roleAssignments.create(scope, assignmentName, {
      principalId: opts.principalObjectId,
      roleDefinitionId,
      principalType: 'ServicePrincipal',
    });
    log.info({ scope, principalObjectId: opts.principalObjectId }, 'Contributor role assigned');
    return { id: result.id ?? assignmentName, created: true };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const status = (err as { statusCode?: number }).statusCode;
    if (
      code === 'RoleAssignmentExists' ||
      status === 409 ||
      /already exists/i.test((err as Error).message ?? '')
    ) {
      log.info({ scope, principalObjectId: opts.principalObjectId }, 'role assignment already exists');
      return { id: assignmentName, created: false };
    }
    if (status === 403 || code === 'AuthorizationFailed') {
      throw new ProvisioningError(
        `RBAC denied creating Contributor assignment on ${scope}`,
        { cause: err, details: { scope, principalObjectId: opts.principalObjectId } },
      );
    }
    throw new AppFactoryError('ROLE_ASSIGNMENT', `failed to assign Contributor on ${scope}`, {
      cause: err,
      details: { scope, principalObjectId: opts.principalObjectId },
    });
  }
}

export interface AssignAppAdminOptions {
  principalObjectId: string;
  graph?: GraphClient;
}

export async function assignAppAdminRole(
  cred: TokenCredential,
  opts: AssignAppAdminOptions,
): Promise<{ assigned: boolean; warning?: string }> {
  const graph = opts.graph ?? createGraphClient(cred);
  try {
    let roleId: string | undefined;
    try {
      const existing = await graph.request<{ value: Array<{ id: string; roleTemplateId: string }> }>(
        'GET',
        `/directoryRoles?$filter=roleTemplateId eq '${CLOUD_APP_ADMIN_TEMPLATE_ID}'`,
      );
      roleId = existing.value[0]?.id;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'directoryRoles lookup failed');
    }
    if (!roleId) {
      try {
        const activated = await graph.request<{ id: string }>('POST', '/directoryRoles', {
          roleTemplateId: CLOUD_APP_ADMIN_TEMPLATE_ID,
        });
        roleId = activated.id;
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (!/already exists/i.test(msg)) throw err;
      }
    }
    if (!roleId) {
      const warning = 'could not resolve Cloud Application Administrator directory role';
      log.warn(warning);
      return { assigned: false, warning };
    }

    await graph.request('POST', `/directoryRoles/${roleId}/members/$ref`, {
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${opts.principalObjectId}`,
    });
    log.info({ principalObjectId: opts.principalObjectId, roleId }, 'Cloud App Admin assigned');
    return { assigned: true };
  } catch (err) {
    const warning = `assignAppAdminRole best-effort failed: ${(err as Error).message}`;
    log.warn({ err: (err as Error).message }, warning);
    return { assigned: false, warning };
  }
}
