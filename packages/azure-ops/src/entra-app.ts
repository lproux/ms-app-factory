import type { TokenCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';
import { AppFactoryError, ProvisioningError, createLogger } from '@app-factory/shared';
import { createGraphClient, type GraphClient } from './graph.js';

const log = createLogger('azure-ops:entra-app');

const BOT_SERVICE_API_VERSION = '2022-09-15';

export interface RequiredResourceAccess {
  resourceAppId: string;
  resourceAccess: { id: string; type: 'Scope' | 'Role' }[];
}

export interface CreateEntraAppOptions {
  displayName: string;
  redirectUris?: string[];
  requiredResourceAccess?: RequiredResourceAccess[];
  signInAudience?: 'AzureADMyOrg' | 'AzureADMultipleOrgs' | 'AzureADandPersonalMicrosoftAccount';
  graph?: GraphClient;
}

export interface EntraAppCreated {
  appId: string;
  objectId: string;
  displayName: string;
  secret: string;
  secretExpiry: string;
}

interface AppCreateResponse {
  id: string;
  appId: string;
  displayName: string;
}

interface AddPasswordResponse {
  secretText: string;
  endDateTime: string;
}

export async function createEntraApp(
  cred: TokenCredential,
  opts: CreateEntraAppOptions,
): Promise<EntraAppCreated> {
  const graph = opts.graph ?? createGraphClient(cred);

  const body: Record<string, unknown> = {
    displayName: opts.displayName,
    signInAudience: opts.signInAudience ?? 'AzureADMyOrg',
  };
  if (opts.redirectUris && opts.redirectUris.length > 0) {
    body.web = { redirectUris: opts.redirectUris };
  }
  if (opts.requiredResourceAccess && opts.requiredResourceAccess.length > 0) {
    body.requiredResourceAccess = opts.requiredResourceAccess;
  }

  const app = await graph.request<AppCreateResponse>('POST', '/applications', body);

  const password = await graph.request<AddPasswordResponse>(
    'POST',
    `/applications/${app.id}/addPassword`,
    {
      passwordCredential: {
        displayName: `app-factory-${new Date().toISOString().slice(0, 10)}`,
      },
    },
  );

  log.info({ appId: app.appId, objectId: app.id, displayName: opts.displayName }, 'Entra app created');

  return {
    appId: app.appId,
    objectId: app.id,
    displayName: app.displayName,
    secret: password.secretText,
    secretExpiry: password.endDateTime,
  };
}

export interface CreateBotRegistrationOptions {
  subId: string;
  rgName: string;
  location?: string;
  displayName: string;
  messagingEndpoint: string;
  appId: string;
  msaAppType?: 'SingleTenant' | 'MultiTenant' | 'UserAssignedMSI';
  tenantId?: string;
  sku?: 'F0' | 'S1';
}

export interface BotRegistration {
  botId: string;
  resourceId: string;
  channels: string[];
}

export async function createBotRegistration(
  cred: TokenCredential,
  opts: CreateBotRegistrationOptions,
): Promise<BotRegistration> {
  const client = new ResourceManagementClient(cred, opts.subId);
  const location = opts.location ?? 'global';
  const sku = opts.sku ?? 'F0';
  const msaAppType = opts.msaAppType ?? 'SingleTenant';

  const properties: Record<string, unknown> = {
    displayName: opts.displayName,
    endpoint: opts.messagingEndpoint,
    msaAppId: opts.appId,
    msaAppType,
  };
  if (msaAppType === 'SingleTenant' && opts.tenantId) {
    properties.msaAppTenantId = opts.tenantId;
  }

  const parameters = {
    location,
    sku: { name: sku },
    kind: 'azurebot',
    properties,
  };

  try {
    const result = await client.resources.beginCreateOrUpdateAndWait(
      opts.rgName,
      'Microsoft.BotService',
      '',
      'botServices',
      opts.displayName,
      BOT_SERVICE_API_VERSION,
      parameters,
    );
    const id =
      result.id ??
      `/subscriptions/${opts.subId}/resourceGroups/${opts.rgName}/providers/Microsoft.BotService/botServices/${opts.displayName}`;
    log.info({ botName: opts.displayName, id }, 'bot registration created/updated');
    return { botId: opts.appId, resourceId: id, channels: ['msteams'] };
  } catch (err) {
    const code = (err as { code?: string }).code;
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 409 || /already exists/i.test((err as Error).message ?? '')) {
      log.info({ botName: opts.displayName }, 'bot registration already exists');
      return {
        botId: opts.appId,
        resourceId: `/subscriptions/${opts.subId}/resourceGroups/${opts.rgName}/providers/Microsoft.BotService/botServices/${opts.displayName}`,
        channels: ['msteams'],
      };
    }
    if (status === 403 || code === 'AuthorizationFailed') {
      throw new ProvisioningError(
        `RBAC denied creating bot registration "${opts.displayName}"`,
        { cause: err, details: { botName: opts.displayName, rgName: opts.rgName } },
      );
    }
    throw new AppFactoryError('BOT_REGISTRATION', `failed to create bot registration "${opts.displayName}"`, {
      cause: err,
      details: { botName: opts.displayName, rgName: opts.rgName },
    });
  }
}
