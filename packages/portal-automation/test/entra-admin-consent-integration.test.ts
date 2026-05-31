import { describe, expect, it, vi } from 'vitest';
import type { Locator, Page } from '../src/types.js';

/**
 * End-to-end masking proof: drive `EntraAdminConsentPage.signInAndConsent`
 * through a stub Playwright `Page` and a mocked `createLogger`, then verify
 * the cleartext password never appears in *any* captured log invocation.
 *
 * `vi.mock` is hoisted so it intercepts the module-level `createLogger` call
 * inside `pages/entra-admin-consent.ts` BEFORE the file executes.
 */

const calls: { level: string; obj: unknown; msg?: string }[] = [];

vi.mock('@app-factory/shared', async () => {
  const real = await vi.importActual<typeof import('@app-factory/shared')>('@app-factory/shared');
  const makeLog = () => {
    const fn = (level: string) => (obj: unknown, msg?: string) => {
      calls.push({ level, obj, msg });
    };
    return {
      info: fn('info'),
      warn: fn('warn'),
      error: fn('error'),
      debug: fn('debug'),
      trace: fn('trace'),
      fatal: fn('fatal'),
    };
  };
  return {
    ...real,
    createLogger: (() => makeLog()) as unknown as typeof real.createLogger,
  };
});

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
  };
  return { ...loc, ...overrides };
}

function makeStubPage(): Page {
  const fallback = makeLocator();
  return {
    goto: vi.fn(async () => undefined),
    url: vi.fn(() => 'https://login.microsoftonline.com/contoso/adminconsent'),
    getByRole: vi.fn(() => fallback),
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
}

describe('EntraAdminConsentPage.signInAndConsent: password never reaches pino sink', () => {
  it('runs end-to-end and only *** appears in captured log calls', async () => {
    // Import lazily so the hoisted vi.mock above is active when the module
    // resolves `createLogger`.
    const { EntraAdminConsentPage } = await import('../src/pages/entra-admin-consent.js');
    calls.length = 0;
    const page = makeStubPage();
    const pageObj = new EntraAdminConsentPage(page);
    const secret = 'P@ssw0rd!-integration';

    await pageObj.signInAndConsent({
      username: 'admin@contoso.onmicrosoft.com',
      password: secret,
      tenantId: 'contoso',
      clientId: '11111111-1111-1111-1111-111111111111',
    });

    expect(calls.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(calls);
    expect(serialised).not.toContain(secret);
    expect(serialised).toContain('***');
    const masked = calls.find((c) => {
      const o = c.obj as Record<string, unknown> | undefined;
      return o !== undefined && 'password' in o;
    });
    expect(masked).toBeDefined();
    expect((masked?.obj as Record<string, unknown>).password).toBe('***');
  });
});
