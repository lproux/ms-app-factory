import { PortalRequiredError, createLogger } from '@app-factory/shared';
import type { BrowserOptions, Page } from './types.js';

const log = createLogger('portal-automation:browser');

const PLAYWRIGHT_DOCS_URL = 'https://playwright.dev/docs/intro';

/**
 * Env vars that Playwright (or its debug helpers) interpret as requests to
 * record traces. If any are set we force-disable tracing and emit a warning
 * so the operator knows the App Factory will not honour the request.
 */
const TRACE_ENV_VARS = [
  'PWDEBUG',
  'PLAYWRIGHT_TRACE',
  'PLAYWRIGHT_HAR',
  'PLAYWRIGHT_VIDEO',
] as const;

function detectTraceEnvRequest(env: NodeJS.ProcessEnv = process.env): string[] {
  const flagged: string[] = [];
  for (const name of TRACE_ENV_VARS) {
    if (env[name] !== undefined && env[name] !== '') flagged.push(name);
  }
  for (const k of Object.keys(env)) {
    if (/^PLAYWRIGHT_.*_TRACE$/i.test(k) && env[k] !== undefined && env[k] !== '') {
      if (!flagged.includes(k)) flagged.push(k);
    }
  }
  return flagged;
}

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

/**
 * Exposed for tests. Returns the BrowserContext options that
 * {@link withBrowser} would pass to Playwright, with secret-leaking
 * recorders force-disabled.
 */
export function buildSafeContextOptions(opts: BrowserOptions = {}): Record<string, unknown> {
  const contextOpts: Record<string, unknown> = {};
  if (opts.storageStatePath) contextOpts.storageState = opts.storageStatePath;
  // Force-disable Playwright's secret-leaking recorders. Screenshots of the
  // login page in a trace.zip would otherwise persist credentials typed by
  // the orchestrator, and the App Factory cannot redact secrets from a binary
  // Playwright trace bundle. See SECURITY_CRITIC findings (H2).
  contextOpts.recordVideo = undefined;
  contextOpts.recordHar = undefined;
  return contextOpts;
}

export async function withBrowser<T>(
  fn: (page: Page) => Promise<T>,
  opts: BrowserOptions = {},
): Promise<T> {
  const flaggedEnv = detectTraceEnvRequest();
  if (flaggedEnv.length > 0) {
    log.warn(
      { envVars: flaggedEnv },
      'tracing was requested by the env but is force-disabled because the App Factory cannot redact secrets from a trace',
    );
  }

  const pw = await loadPlaywright();
  const headless = opts.headless ?? true;
  const browser = await pw.chromium.launch({ headless });
  log.info({ headless }, 'browser launched');
  try {
    const contextOpts = buildSafeContextOptions(opts);
    const context = await browser.newContext(contextOpts);
    // Explicitly do not call `context.tracing.start(...)`. Tracing remains
    // off by default in Playwright but we make the intent visible here so a
    // future refactor cannot quietly enable it without an opt-in flag.
    const page = (await context.newPage()) as Page;
    return await fn(page);
  } finally {
    await browser.close();
    log.info('browser closed');
  }
}
