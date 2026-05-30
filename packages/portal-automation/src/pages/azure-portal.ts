import { ProvisioningError, createLogger, span } from '@app-factory/shared';
import { withBrowser } from '../browser.js';
import type { BrowserOptions, Page } from '../types.js';

const log = createLogger('portal:azure-portal');

export interface GrantRoleOpts {
  scope: string;
  role: string;
  principalId: string;
}

const AZURE_PORTAL_HOME = 'https://portal.azure.com/';

export class AzurePortalPage {
  constructor(private readonly page: Page) {}

  async openSubscription(id: string): Promise<void> {
    return span('portal:azure.openSubscription', async () => {
      const url = `${AZURE_PORTAL_HOME}#@/resource/subscriptions/${encodeURIComponent(id)}/overview`;
      log.info({ id, url }, 'opening subscription blade');
      await this.page.goto(url);
      await this.page.waitForLoadState('networkidle');
      const banner = this.page.getByRole('heading', { name: new RegExp(id.slice(0, 8), 'i') });
      const visible = await banner.isVisible().catch(() => false);
      if (!visible) {
        const ok = await this.page
          .getByText(/subscription/i)
          .first()
          .isVisible()
          .catch(() => false);
        if (!ok) {
          throw new ProvisioningError('subscription blade did not load', { details: { id } });
        }
      }
    });
  }

  async grantRole(opts: GrantRoleOpts): Promise<void> {
    return span('portal:azure.grantRole', async () => {
      const url = `${AZURE_PORTAL_HOME}#blade/Microsoft_Azure_AD/RoleAssignmentBlade/scope/${encodeURIComponent(opts.scope)}`;
      log.info(opts, 'opening role-assignment blade');
      await this.page.goto(url);
      await this.page.waitForLoadState('networkidle');

      await this.page.getByRole('button', { name: /add|^\+ add$|add role assignment/i }).click();

      const roleCombo = this.page.getByRole('combobox', { name: /role/i });
      await roleCombo.click();
      await roleCombo.fill(opts.role);
      await this.page.getByRole('option', { name: new RegExp(`^${opts.role}$`, 'i') }).click();

      const principalBox = this.page.getByRole('textbox', { name: /select|principal|member/i });
      await principalBox.fill(opts.principalId);
      await this.page
        .getByText(opts.principalId, { exact: false })
        .first()
        .click();

      await this.page.getByRole('button', { name: /review \+ assign|save|assign/i }).click();
      log.info(opts, 'role assignment submitted');
    });
  }
}

export async function withAzurePortalPage<T>(
  fn: (pageObj: AzurePortalPage, page: Page) => Promise<T>,
  opts?: BrowserOptions,
): Promise<T> {
  return withBrowser((page) => fn(new AzurePortalPage(page), page), opts);
}

export { withBrowser } from '../browser.js';
