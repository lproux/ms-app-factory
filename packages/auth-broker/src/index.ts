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
          userPromptCallback: (info) => emitDeviceCodePrompt(info),
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
              userPromptCallback: (info) => emitDeviceCodePrompt(info),
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

const DEFAULT_REDIRECT = 'https://login.microsoftonline.com/common/oauth2/nativeclient';

/**
 * Allowlist for adminConsent redirect_uri values. Extend via the optional
 * `extraAllowedRedirects` arg when wiring the consent URL into a specific
 * registered app — never by accepting an arbitrary string from user input.
 */
const DEFAULT_ALLOWED_REDIRECT_HOSTS = new Set<string>([
  'login.microsoftonline.com',
  'login.live.com',
]);

function isSafeRedirect(uri: string, extraAllowedHosts: Set<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (/^[0-9.]+$/.test(parsed.hostname) || parsed.hostname.includes(':')) return false; // IP literal
  return DEFAULT_ALLOWED_REDIRECT_HOSTS.has(parsed.hostname) || extraAllowedHosts.has(parsed.hostname);
}

export function adminConsentUrl(
  opts: AdminConsentUrlOptions,
  extraAllowedHosts: Set<string> = new Set(),
): string {
  const redirect = opts.redirectUri ?? DEFAULT_REDIRECT;
  if (!isSafeRedirect(redirect, extraAllowedHosts)) {
    throw new AuthError(
      `adminConsentUrl: redirect_uri ${redirect} is not in the allowlist (login.microsoftonline.com, login.live.com, or caller-provided hosts only).`,
    );
  }
  if (!opts.state || opts.state.length < 8) {
    throw new AuthError('adminConsentUrl: a state parameter of at least 8 characters is required to prevent CSRF.');
  }
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: redirect,
    scope: opts.scope ?? 'https://graph.microsoft.com/.default',
    state: opts.state,
  });
  return `https://login.microsoftonline.com/${opts.tenantId}/adminconsent?${params.toString()}`;
}

/**
 * Emit the device-code prompt for the operator without leaking the userCode
 * through structured logs. The bearer code is printed only to stderr (TTY or
 * not — the operator may be running in a headless context); pino sees a
 * redacted event with no credential material.
 */
function emitDeviceCodePrompt(info: {
  message: string;
  verificationUri: string;
  userCode: string;
  expiresOn?: Date;
}): void {
  process.stderr.write(`\n${info.message}\n`);
  log.info(
    { verificationUri: info.verificationUri, userCodePresent: true, expiresOn: info.expiresOn },
    'device-code prompt issued (userCode redacted; see stderr)',
  );
}

export { type TokenCredential };
