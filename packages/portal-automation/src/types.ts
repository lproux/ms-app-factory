/**
 * Structural Playwright-compatible Page/Locator subset used by this package.
 *
 * We intentionally avoid importing types from `playwright` so the package
 * typechecks and builds even when the playwright runtime/browsers are not
 * installed (it is loaded lazily by `withBrowser`). The real Playwright
 * `Page` object satisfies this interface structurally at runtime.
 */

export interface Locator {
  fill(value: string): Promise<void>;
  click(opts?: Record<string, unknown>): Promise<void>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  isVisible(): Promise<boolean>;
  waitFor(opts?: Record<string, unknown>): Promise<void>;
  press(key: string): Promise<void>;
  first(): Locator;
  count(): Promise<number>;
}

export interface ByRoleOptions {
  name?: string | RegExp;
  exact?: boolean;
}

export interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  url(): string;
  getByRole(role: string, opts?: ByRoleOptions): Locator;
  getByText(text: string | RegExp, opts?: { exact?: boolean }): Locator;
  getByLabel(label: string | RegExp): Locator;
  getByPlaceholder(placeholder: string | RegExp): Locator;
  locator(selector: string): Locator;
  waitForURL(url: string | RegExp, opts?: Record<string, unknown>): Promise<void>;
  waitForLoadState(state?: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  textContent(selector?: string): Promise<string | null>;
  content(): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserOptions {
  headless?: boolean;
  storageStatePath?: string;
}
