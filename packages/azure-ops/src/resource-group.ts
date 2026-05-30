import type { TokenCredential } from '@azure/identity';
import { ResourceManagementClient } from '@azure/arm-resources';
import { ProvisioningError, createLogger } from '@app-factory/shared';

const log = createLogger('azure-ops:resource-group');

export interface ResourceGroupRef {
  id: string;
  name: string;
  location: string;
}

export async function ensureResourceGroup(
  cred: TokenCredential,
  subId: string,
  name: string,
  location: string,
): Promise<ResourceGroupRef> {
  const client = new ResourceManagementClient(cred, subId);
  try {
    const existing = await client.resourceGroups.get(name);
    if (existing) {
      log.info({ name, id: existing.id }, 'resource group already exists');
      return {
        id: existing.id ?? `/subscriptions/${subId}/resourceGroups/${name}`,
        name: existing.name ?? name,
        location: existing.location ?? location,
      };
    }
  } catch (err) {
    const code = (err as { statusCode?: number; code?: string }).statusCode;
    if (code !== 404 && (err as { code?: string }).code !== 'ResourceGroupNotFound') {
      if (code === 403 || (err as { code?: string }).code === 'AuthorizationFailed') {
        throw new ProvisioningError(
          `RBAC denied reading resource group "${name}" in subscription ${subId}`,
          { cause: err, details: { subId, name } },
        );
      }
      log.warn({ err: (err as Error).message }, 'resource-group get failed unexpectedly; will attempt create');
    }
  }

  try {
    const created = await client.resourceGroups.createOrUpdate(name, { location });
    log.info({ name, id: created.id, location }, 'resource group created/updated');
    return {
      id: created.id ?? `/subscriptions/${subId}/resourceGroups/${name}`,
      name: created.name ?? name,
      location: created.location ?? location,
    };
  } catch (err) {
    const code = (err as { statusCode?: number; code?: string }).statusCode;
    if (code === 403 || (err as { code?: string }).code === 'AuthorizationFailed') {
      throw new ProvisioningError(
        `RBAC denied creating resource group "${name}" in subscription ${subId}`,
        { cause: err, details: { subId, name } },
      );
    }
    throw new ProvisioningError(`failed to create resource group "${name}"`, {
      cause: err,
      details: { subId, name, location },
    });
  }
}
