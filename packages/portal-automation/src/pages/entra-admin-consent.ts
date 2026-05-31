import { AuthError, createLogger, span } from '@app-factory/shared';
import { withBrowser } from '../browser.js';
import type { BrowserOptions, Page } from '../types.js';

const log = createLogger('portal-automation:entra-admin-consent');

/**
 * Field names that this page object must never emit to logs in cleartext.
 * Anything matching this list (case-insensitive) is replaced with `***`
 * before being passed to pino. Mirrors {@link SECRET_KEY_PATTERN} from
 * `computer-use.ts` but is intentionally narrower — this page object only
 * ever sees auth-flow inputs, so we hard-code the exact field names.
 */
const MASKED_FIELDS = ['password', 'pwd', 'pass', 'code', 'devicecode', 'device_code'] as const;
const MASK = '***';

/**
 * Return a shallow clone of `obj` with any value at a key in
 * {@link MASKED_FIELDS} (case-insensitive) replaced by `***`. Pino will
 * serialise this directly — the original `opts` object stays unmodified
 * so the page object can still pass cleartext credentials to Playwright.
 *
 * Exported for the test suite; not part of the public package surface.
 */
export function maskForLog(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (MASKED_FIELDS.some((m) => m.toLowerCase() === k.toLowerCase())) {
      out[k] = MASK;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface AdminConsentUrlOpts {
  tenantId: string;
  clientId: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
}

export function buildAdminConsentUrl(opts: AdminConsentUrlOpts): string {
  const params = new URLSearchParams();
  params.set('client_id', opts.clientId);
  if (opts.redirectUri) params.set('redirect_uri', opts.redirectUri);
  if (opts.scope) params.set('scope', opts.scope);
  if (opts.state) params.set('state', opts.state);
  const qs = params.toString();
  const base = `https://login.microsoftonline.com/${encodeURIComponent(opts.tenantId)}/adminconsent`;
  return qs ? `${base}?${qs}` : base;
}

export interface SignInAndConsentOpts {
  username: string;
  password?: string;
  tenantId: string;
  clientId: string;
  redirectUri?: string;
  scope?: string;
  deviceCodeHook?: (code: string) => Promise<void>;
}

const DEVICE_CODE_PATTERN = /\b[A-Z0-9]{8,}\b/;

export class EntraAdminConsentPage {
  constructor(private readonly page: Page) {}

  async signInAndConsent(opts: SignInAndConsentOpts): Promise<void> {
    return span('portal:entra-admin-consent.signInAndConsent', async () => {
      const url = buildAdminConsentUrl({
        tenantId: opts.tenantId,
        clientId: opts.clientId,
        redirectUri: opts.redirectUri,
        scope: opts.scope,
      });
      log.info(
        maskForLog({
          url,
          username: opts.username,
          password: opts.password,
          tenantId: opts.tenantId,
          clientId: opts.clientId,
        }),
        'navigating to admin-consent URL',
      );
      await this.page.goto(url);

      const emailBox = this.page.getByRole('textbox', { name: /email|sign[- ]?in|username/i });
      await emailBox.waitFor({ state: 'visible' });
      await emailBox.fill(opts.username);

      const nextBtn = this.page.getByRole('button', { name: /next/i });
      await nextBtn.click();

      if (opts.password) {
        const pwBox = this.page.getByRole('textbox', { name: /password/i });
        await pwBox.waitFor({ state: 'visible' });
        await pwBox.fill(opts.password);
        const signInBtn = this.page.getByRole('button', { name: /sign in|signin/i });
        await signInBtn.click();
      } else if (opts.deviceCodeHook) {
        const codeLocator = this.page.getByText(DEVICE_CODE_PATTERN).first();
        await codeLocator.waitFor({ state: 'visible' });
        const text = (await codeLocator.textContent()) ?? '';
        const match = text.match(DEVICE_CODE_PATTERN);
        if (!match) {
          throw new AuthError('device code element matched but text contained no code', {
            details: { text },
          });
        }
        const code = match[0];
        log.info(maskForLog({ code }), 'device code captured; invoking hook');
        await opts.deviceCodeHook(code);
      } else {
        throw new AuthError(
          'no password or deviceCodeHook supplied; cannot complete sign-in non-interactively',
        );
      }

      const consentBtn = this.page.getByRole('button', { name: /accept|consent|grant/i });
      await consentBtn.waitFor({ state: 'visible' });
      await consentBtn.click();
      log.info(
        maskForLog({ tenantId: opts.tenantId, clientId: opts.clientId }),
        'admin consent submitted',
      );
    });
  }
}

export async function withEntraAdminConsentPage<T>(
  fn: (pageObj: EntraAdminConsentPage, page: Page) => Promise<T>,
  opts?: BrowserOptions,
): Promise<T> {
  return withBrowser((page) => fn(new EntraAdminConsentPage(page), page), opts);
}

export { withBrowser } from '../browser.js';
