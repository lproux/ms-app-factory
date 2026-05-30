import { PortalRequiredError, createLogger } from '@app-factory/shared';
import type { BrowserOptions, Page } from './types.js';

const log = createLogger('portal:browser');

const PLAYWRIGHT_DOCS_URL = 'https://playwright.dev/docs/intro';

async function loadPlaywright(): Promise<{
  chromium: {
    launch(opts?: Record<string, unknown>): Promise<{
      newContext(opts?: Record<string, unknown>): Promise<{
        newPage(): Promise<unknown>;
      }>;
      close(): Promise<void>;
    }>;
  };
}> {
  try {
    // @ts-ignore - playwright is an optional runtime dependency loaded lazily;
    // install with `pnpm dlx playwright install` before invoking withBrowser.
    const mod = await import('playwright');
    return mod as never;
  } catch (err) {
    throw new PortalRequiredError(
      'playwright is not installed; run `pnpm dlx playwright install` to enable the portal fallback',
      PLAYWRIGHT_DOCS_URL,
      { cause: err },
    );
  }
}

export async function withBrowser<T>(
  fn: (page: Page) => Promise<T>,
  opts: BrowserOptions = {},
): Promise<T> {
  const pw = await loadPlaywright();
  const headless = opts.headless ?? true;
  const browser = await pw.chromium.launch({ headless });
  log.info({ headless }, 'browser launched');
  try {
    const contextOpts: Record<string, unknown> = {};
    if (opts.storageStatePath) contextOpts.storageState = opts.storageStatePath;
    const context = await browser.newContext(contextOpts);
    const page = (await context.newPage()) as Page;
    return await fn(page);
  } finally {
    await browser.close();
    log.info('browser closed');
  }
}
