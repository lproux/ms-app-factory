import { ProvisioningError, createLogger, span } from '@app-factory/shared';
import { withBrowser } from '../browser.js';
import type { BrowserOptions, Page } from '../types.js';

const log = createLogger('portal:power-platform-admin');

export type EnvironmentType = 'Trial' | 'Sandbox' | 'Production' | 'Developer';

export interface CreateEnvironmentOpts {
  name: string;
  region: string;
  type: EnvironmentType;
}

export interface CreateEnvironmentResult {
  environmentId: string;
  url: string;
}

export interface AssignSecurityRoleOpts {
  environmentId: string;
  userPrincipalName: string;
  role: string;
}

const PPAC_HOME = 'https://admin.powerplatform.microsoft.com/';
const ENV_ID_FROM_URL = /environments\/([0-9a-fA-F-]{36})/;

export class PowerPlatformAdminPage {
  constructor(private readonly page: Page) {}

  async createEnvironment(opts: CreateEnvironmentOpts): Promise<CreateEnvironmentResult> {
    return span('portal:ppac.createEnvironment', async () => {
      log.info({ name: opts.name, region: opts.region, type: opts.type }, 'creating environment');
      await this.page.goto(`${PPAC_HOME}#/environments`);
      await this.page.waitForLoadState('networkidle');

      await this.page.getByRole('button', { name: /^new$|create environment|^\+ new$/i }).click();

      const nameBox = this.page.getByRole('textbox', { name: /name/i });
      await nameBox.waitFor({ state: 'visible' });
      await nameBox.fill(opts.name);

      const regionCombo = this.page.getByRole('combobox', { name: /region/i });
      await regionCombo.click();
      await this.page.getByRole('option', { name: new RegExp(opts.region, 'i') }).click();

      const typeCombo = this.page.getByRole('combobox', { name: /type|environment type/i });
      await typeCombo.click();
      await this.page.getByRole('option', { name: new RegExp(`^${opts.type}$`, 'i') }).click();

      await this.page.getByRole('button', { name: /next/i }).click();
      await this.page.getByRole('button', { name: /save|create|finish/i }).click();

      const link = this.page.getByRole('link', { name: new RegExp(opts.name, 'i') });
      await link.waitFor({ state: 'visible', timeout: 120_000 });
      await link.click();
      await this.page.waitForLoadState('networkidle');

      const currentUrl = this.page.url();
      const match = currentUrl.match(ENV_ID_FROM_URL);
      if (!match || !match[1]) {
        throw new ProvisioningError('could not parse environment id from PPAC URL', {
          details: { url: currentUrl, name: opts.name },
        });
      }
      const environmentId = match[1];
      log.info({ environmentId, url: currentUrl }, 'environment created');
      return { environmentId, url: currentUrl };
    });
  }

  async assignSecurityRole(opts: AssignSecurityRoleOpts): Promise<void> {
    return span('portal:ppac.assignSecurityRole', async () => {
      log.info(opts, 'assigning security role');
      await this.page.goto(
        `${PPAC_HOME}#/environments/${encodeURIComponent(opts.environmentId)}/users`,
      );
      await this.page.waitForLoadState('networkidle');

      await this.page.getByRole('button', { name: /add user|new user/i }).click();
      const upn = this.page.getByRole('textbox', { name: /user|email|principal/i });
      await upn.fill(opts.userPrincipalName);
      await this.page.getByRole('button', { name: /search|find/i }).click();

      const userRow = this.page.getByText(opts.userPrincipalName).first();
      await userRow.waitFor({ state: 'visible' });
      await userRow.click();

      await this.page.getByRole('button', { name: /manage roles|assign role/i }).click();
      const roleCheckbox = this.page.getByRole('checkbox', { name: new RegExp(opts.role, 'i') });
      await roleCheckbox.click();
      await this.page.getByRole('button', { name: /save|apply/i }).click();
      log.info(opts, 'security role assigned');
    });
  }
}

export async function withPowerPlatformAdminPage<T>(
  fn: (pageObj: PowerPlatformAdminPage, page: Page) => Promise<T>,
  opts?: BrowserOptions,
): Promise<T> {
  return withBrowser((page) => fn(new PowerPlatformAdminPage(page), page), opts);
}

export { withBrowser } from '../browser.js';
