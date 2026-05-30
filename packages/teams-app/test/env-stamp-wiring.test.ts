import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stampEnvFile } from '@app-factory/azure-ops';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.teams-env-wiring-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * Simulates the B6 wiring: given Entra + bot info, stamp the env/.env.dev
 * file with the exact var names B6 emits.
 */
describe('B6 env stamping wiring', () => {
  it('writes TEAMS_APP_ID, AAD_APP_CLIENT_ID, AAD_APP_TENANT_ID, BOT_ID into env/.env.dev', async () => {
    const projectPath = dir;
    const envFile = join(projectPath, 'env', '.env.dev');

    const entra = { appId: 'app-guid', objectId: 'obj-guid', tenantId: 'tenant-guid' };
    const bot = { botId: 'app-guid', channels: ['msteams'] };

    await stampEnvFile(envFile, {
      TEAMS_APP_ID: entra.appId,
      AAD_APP_CLIENT_ID: entra.appId,
      AAD_APP_OBJECT_ID: entra.objectId,
      AAD_APP_TENANT_ID: entra.tenantId,
      BOT_ID: bot.botId,
    });

    const out = await readFile(envFile, 'utf8');
    expect(out).toContain('TEAMS_APP_ID=app-guid');
    expect(out).toContain('AAD_APP_CLIENT_ID=app-guid');
    expect(out).toContain('AAD_APP_OBJECT_ID=obj-guid');
    expect(out).toContain('AAD_APP_TENANT_ID=tenant-guid');
    expect(out).toContain('BOT_ID=app-guid');
  });

  it('teamsAppSteps preserves the B2..B14 id graph', async () => {
    vi.mock('@app-factory/azure-ops', async (orig) => {
      const real = (await orig()) as Record<string, unknown>;
      return real;
    });
    const { teamsAppSteps } = await import('../src/index.js');
    const ids = teamsAppSteps.map((s) => s.id);
    expect(ids).toEqual([
      'B2-scaffold',
      'B3-azure-rg',
      'B4-sp',
      'B5-pim',
      'B6-registrations',
      'B7-provision',
      'B8-deploy',
      'B9-package',
      'B10-validate',
      'B11-publish',
      'B12-smoke-test',
      'B13-judge-panel',
      'B14-emit-secrets',
    ]);
    const dep = new Map(teamsAppSteps.map((s) => [s.id, s.dependsOn ?? []]));
    expect(dep.get('B3-azure-rg')).toEqual(['B2-scaffold']);
    expect(dep.get('B6-registrations')).toEqual(['B5-pim']);
    expect(dep.get('B14-emit-secrets')).toEqual(['B13-judge-panel']);
  });
});
