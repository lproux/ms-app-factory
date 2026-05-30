import { describe, expect, it, vi } from 'vitest';
import { PortalRequiredError } from '@app-factory/shared';
import { withFallback } from '../src/fallback.js';
import { EntraAdminConsentPage } from '../src/pages/entra-admin-consent.js';
import type { Locator, Page } from '../src/types.js';

function makeLocator(overrides: Partial<Locator> = {}): Locator {
  const loc: Locator = {
    fill: vi.fn(async () => undefined),
    click: vi.fn(async () => undefined),
    textContent: vi.fn(async () => null),
    innerText: vi.fn(async () => ''),
    isVisible: vi.fn(async () => true),
    waitFor: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    count: vi.fn(async () => 1),
    first: vi.fn((): Locator => loc),
    ...overrides,
  };
  return loc;
}

function makeStubPage(): { page: Page; locators: Record<string, Locator> } {
  const emailBox = makeLocator();
  const nextBtn = makeLocator();
  const passwordBox = makeLocator();
  const signInBtn = makeLocator();
  const consentBtn = makeLocator();
  const fallback = makeLocator();
  const locators = { emailBox, nextBtn, passwordBox, signInBtn, consentBtn };

  const page: Page = {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://login.microsoftonline.com/tenant/adminconsent'),
    getByRole: vi.fn((role: string, opts?: { name?: string | RegExp }) => {
      const name = opts?.name;
      const test = (re: RegExp) =>
        name instanceof RegExp ? re.source === name.source || re.test(String(name)) : false;
      if (role === 'textbox' && name instanceof RegExp && /email|sign[- ]?in|username/i.source) {
        if (test(/email|sign[- ]?in|username/i)) return emailBox;
        if (test(/password/i)) return passwordBox;
      }
      if (role === 'textbox' && name instanceof RegExp) {
        if (name.test('Email')) return emailBox;
        if (name.test('Password')) return passwordBox;
      }
      if (role === 'button' && name instanceof RegExp) {
        if (name.test('Next')) return nextBtn;
        if (name.test('Sign in')) return signInBtn;
        if (name.test('Accept') || name.test('Consent') || name.test('Grant')) return consentBtn;
      }
      return fallback;
    }),
    getByText: vi.fn(() => fallback),
    getByLabel: vi.fn(() => fallback),
    getByPlaceholder: vi.fn(() => fallback),
    locator: vi.fn(() => fallback),
    waitForURL: vi.fn(async () => undefined),
    waitForLoadState: vi.fn(async () => undefined),
    waitForTimeout: vi.fn(async () => undefined),
    textContent: vi.fn(async () => null),
    content: vi.fn(async () => '<html></html>'),
    close: vi.fn(async () => undefined),
  };

  return { page, locators };
}

describe('integration A4: entra admin consent fallback', () => {
  it('dispatches to playwright recovery when the primary throws PortalRequiredError', async () => {
    const { page, locators } = makeStubPage();
    const portalErr = new PortalRequiredError(
      'graph admin-consent endpoint requires interactive sign-in',
      'https://login.microsoftonline.com/contoso/adminconsent',
    );

    const fakeEntraAppPrimary = vi.fn(async () => {
      throw portalErr;
    });

    const consentOpts = {
      username: 'admin@contoso.onmicrosoft.com',
      password: 'P@ssw0rd!',
      tenantId: 'contoso.onmicrosoft.com',
      clientId: '11111111-1111-1111-1111-111111111111',
      redirectUri: 'https://localhost/redirect',
      scope: 'https://graph.microsoft.com/.default',
    };

    const playwrightFallback = vi.fn(async () => {
      const pageObj = new EntraAdminConsentPage(page);
      await pageObj.signInAndConsent(consentOpts);
      return 'consented';
    });

    const result = await withFallback({
      primary: fakeEntraAppPrimary,
      playwright: playwrightFallback,
      label: 'A4-entra-app',
    });

    expect(result).toBe('consented');
    expect(fakeEntraAppPrimary).toHaveBeenCalledTimes(1);
    expect(playwrightFallback).toHaveBeenCalledTimes(1);

    expect(page.goto).toHaveBeenCalledWith(
      expect.stringContaining(`https://login.microsoftonline.com/${encodeURIComponent(consentOpts.tenantId)}/adminconsent`),
    );
    const gotoUrl = (page.goto as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(gotoUrl).toContain(`client_id=${consentOpts.clientId}`);
    expect(gotoUrl).toContain(`redirect_uri=${encodeURIComponent(consentOpts.redirectUri)}`);

    expect(locators.emailBox.fill).toHaveBeenCalledWith(consentOpts.username);
    expect(locators.passwordBox.fill).toHaveBeenCalledWith(consentOpts.password);
    expect(locators.nextBtn.click).toHaveBeenCalled();
    expect(locators.signInBtn.click).toHaveBeenCalled();
    expect(locators.consentBtn.click).toHaveBeenCalled();
  });
});
