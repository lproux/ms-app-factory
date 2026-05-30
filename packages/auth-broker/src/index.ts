import {
  ChainedTokenCredential,
  ClientSecretCredential,
  DeviceCodeCredential,
  InteractiveBrowserCredential,
  type TokenCredential,
} from '@azure/identity';
import { AuthError, createLogger, type AuthMode } from '@app-factory/shared';

const log = createLogger('auth-broker');

export interface GetCredentialOptions {
  mode: AuthMode;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  preferDeviceCode?: boolean;
}

export function getCredential(opts: GetCredentialOptions): TokenCredential {
  const tenantId = opts.tenantId ?? process.env.AZURE_TENANT_ID ?? 'organizations';
  log.debug({ mode: opts.mode, tenantId }, 'creating credential');

  switch (opts.mode) {
    case 'interactive': {
      if (opts.preferDeviceCode) {
        return new DeviceCodeCredential({
          tenantId,
          clientId: opts.clientId ?? '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
          userPromptCallback: (info) => {
            log.warn({ verificationUri: info.verificationUri, userCode: info.userCode }, info.message);
          },
        });
      }
      return new InteractiveBrowserCredential({ tenantId });
    }
    case 'sp': {
      const clientId = opts.clientId ?? process.env.AZURE_CLIENT_ID;
      const clientSecret = opts.clientSecret ?? process.env.AZURE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        throw new AuthError('SP mode requires clientId + clientSecret (or AZURE_CLIENT_ID/AZURE_CLIENT_SECRET).');
      }
      return new ClientSecretCredential(tenantId, clientId, clientSecret);
    }
    case 'chained': {
      const chain: TokenCredential[] = [];
      if (process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET) {
        chain.push(
          new ClientSecretCredential(tenantId, process.env.AZURE_CLIENT_ID, process.env.AZURE_CLIENT_SECRET),
        );
      }
      chain.push(
        opts.preferDeviceCode
          ? new DeviceCodeCredential({
              tenantId,
              userPromptCallback: (info) => log.warn({ ...info }, info.message),
            })
          : new InteractiveBrowserCredential({ tenantId }),
      );
      return new ChainedTokenCredential(...chain);
    }
    default:
      throw new AuthError(`unknown auth mode: ${opts.mode satisfies never}`);
  }
}

export interface AdminConsentUrlOptions {
  tenantId: string;
  clientId: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
}

export function adminConsentUrl(opts: AdminConsentUrlOptions): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri ?? 'https://login.microsoftonline.com/common/oauth2/nativeclient',
    scope: opts.scope ?? 'https://graph.microsoft.com/.default',
  });
  if (opts.state) params.set('state', opts.state);
  return `https://login.microsoftonline.com/${opts.tenantId}/adminconsent?${params.toString()}`;
}

export { type TokenCredential };
