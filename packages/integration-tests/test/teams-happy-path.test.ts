import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@app-factory/shared';

const log = createLogger('teams-happy-path');

const mocks = vi.hoisted(() => {
  const calls: { kind: string; target: string; argv?: unknown[] }[] = [];
  const recorder = {
    reset() {
      calls.length = 0;
    },
    record(c: { kind: string; target: string; argv?: unknown[] }) {
      calls.push(c);
    },
    byKind(k: string) {
      return calls.filter((c) => c.kind === k);
    },
  };

  const execaMock = async (
    file: string,
    args: string[] = [],
    _opts: Record<string, unknown> = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    recorder.record({ kind: 'execa', target: file, argv: args });
    if (file === 'atk') {
      if (args[0] === '--version') return { exitCode: 0, stdout: '3.1.0', stderr: '' };
      return { exitCode: 0, stdout: 'atk ok', stderr: '' };
    }
    if (file === 'tmux') return { exitCode: 0, stdout: '', stderr: '' };
    if (file === 'gh') {
      if (args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2.50.0 (mock)', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (file === 'pac') return { exitCode: 0, stdout: 'pac help (mock)', stderr: '' };
    if (file === 'az') return { exitCode: 0, stdout: '{}', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  let spawnCounter = 0;
  const spawnMock = async (
    command: string,
    spawnOpts: { name?: string; session?: string; cwd?: string } = {},
  ) => {
    recorder.record({ kind: 'spawn', target: command, argv: [spawnOpts] });
    const id = `fake-${++spawnCounter}`;
    return {
      id,
      session: spawnOpts.session ?? 'app-factory',
      window: spawnOpts.name ?? `w-${id}`,
      command,
      async send(_keys: string, _enter?: boolean) {
        /* no-op */
      },
      async capture(_lines?: number) {
        return '\n$ ';
      },
      async waitFor(pattern: RegExp) {
        if (/atk-done/.test(pattern.source)) return 'completed\n[atk-done:0]\n';
        if (/PAC_DONE/.test(pattern.source)) return 'PAC_DONE=0\n';
        if (/GIT_DONE/.test(pattern.source)) return 'GIT_DONE=0\n';
        if (/Role activation succeeded|already active|\[pim\]/.test(pattern.source)) {
          return '[pim] activation step finished\n';
        }
        if (/gh version|GH_COPILOT/.test(pattern.source)) return 'gh version 2.50.0 (mock)\n$ ';
        return '$ ';
      },
      async kill() {
        /* no-op */
      },
    };
  };

  const fakeCredential = {
    async getToken(_scopes: string | string[]) {
      return { token: 'fake-token', expiresOnTimestamp: Date.now() + 3600_000 };
    },
  };

  const alwaysApprove = (persona: string, idPrefix: string) => ({
    id: `${idPrefix}:${persona}`,
    persona,
    async review(_artifact: unknown) {
      return {
        judge: `${idPrefix}:${persona}`,
        persona,
        approved: true,
        score: 0.95,
        reason: `synthetic ${persona} approval`,
      };
    },
  });

  return { recorder, execaMock, spawnMock, fakeCredential, alwaysApprove };
});

vi.mock('execa', () => ({
  execa: mocks.execaMock,
}));

vi.mock('@app-factory/orchestrator', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    spawn: mocks.spawnMock,
    ensureSession: async () => undefined,
  };
});

vi.mock('@app-factory/auth-broker', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    getCredential: () => mocks.fakeCredential,
  };
});

vi.mock('@app-factory/judge-panel', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    makeClaudeJudge: (opts: { persona: string }) => mocks.alwaysApprove(opts.persona, 'fake-claude'),
    makeGhCopilotJudge: (opts: { persona: string }) => mocks.alwaysApprove(opts.persona, 'fake-copilot'),
    makeCopilotStudioJudge: (opts: { persona: string }) => mocks.alwaysApprove(opts.persona, 'fake-cs'),
  };
});

vi.mock('@app-factory/azure-ops', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    pickSubscription: async (_cred: unknown, _hint: string) => ({
      id: '00000000-0000-0000-0000-000000000001',
      displayName: 'Fake Sub 1',
    }),
    ensureResourceGroup: async (
      _cred: unknown,
      subId: string,
      name: string,
      location: string,
    ) => ({
      id: `/subscriptions/${subId}/resourceGroups/${name}`,
      name,
      location,
    }),
    createServicePrincipal: async (_cred: unknown, opts: { displayName: string }) => ({
      appId: 'sp-app-id-mock',
      objectId: 'sp-obj-id-mock',
      secret: 'sp-secret-mock',
      password: 'sp-secret-mock',
      secretExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      displayName: opts.displayName,
    }),
    assignContributorOnResourceGroup: async () => ({ id: 'role-asgn-mock', created: true }),
    assignAppAdminRole: async () => ({ assigned: true }),
    activatePim: async () => ({ alreadyActive: true, rawOutput: 'mock pim activation' }),
    createEntraApp: async (_cred: unknown, opts: { displayName: string }) => ({
      appId: 'entra-app-id-mock',
      objectId: 'entra-obj-id-mock',
      displayName: opts.displayName,
      secret: 'entra-secret-mock',
      secretExpiry: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    createBotRegistration: async (
      _cred: unknown,
      opts: { subId: string; rgName: string; displayName: string; appId: string },
    ) => ({
      botId: opts.appId,
      resourceId: `/subscriptions/${opts.subId}/resourceGroups/${opts.rgName}/providers/Microsoft.BotService/botServices/${opts.displayName}`,
      channels: ['msteams'],
    }),
    optimizeCost: async () => [
      {
        resource: 'rg-app-factory',
        recommendation: 'Swap SKU Standard_DS2_v2 → Standard_B2s',
        estimatedMonthlySavingsUsd: 35,
        source: 'sku-heuristic',
      },
    ],
  };
});

vi.mock('keytar', () => ({ default: undefined }));

// -- Imports of the system under test happen AFTER mocks are declared -------

import { runTeamsApp } from '@app-factory/teams-app';
import { FactoryContext } from '@app-factory/shared';

let workdir: string;

beforeEach(async () => {
  mocks.recorder.reset();
  workdir = await mkdtemp(join(tmpdir(), 'af-teams-happy-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('Integration — Teams app happy path', () => {
  it('runs the full WBS B pipeline with teams-bot-basic and emits a clawpilot paste bundle', async () => {
    const fctx = FactoryContext.parse({
      runId: 'teams-happy-001',
      recipe: 'teams-bot-basic',
      planOnly: false,
      workdir,
      brand: { name: 'HelpDesk Bot' },
      kbSources: [],
      tenant: {
        tenantId: 'tenant-mock',
        subscriptionId: 'default',
        resourceGroup: 'rg-app-factory',
        region: 'eastus',
      },
    });

    const result = await runTeamsApp(fctx);

    log.info(
      { ok: result.ok, artifacts: result.artifacts.length, warnings: result.warnings.length },
      'teams run complete',
    );

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);

    const kinds = new Set(result.artifacts.map((a) => a.kind));
    expect(kinds.has('teams-app')).toBe(true);
    expect(kinds.has('azure-resource')).toBe(true);
    expect(kinds.has('sp')).toBe(true);
    expect(kinds.has('entra-app')).toBe(true);
    expect(kinds.has('bot')).toBe(true);

    expect(result.pasteBundle).toContain('# App Factory — Teams app run report');
    expect(result.pasteBundle).toContain('## clawpilot paste block');
    expect(result.pasteBundle).toContain('TEAMS_APP__ENTRA_CLIENT_SECRET');
    expect(result.pasteBundle).toContain('TEAMS_APP__SP_CLIENT_SECRET');
    expect(result.pasteBundle).toContain('## Cost optimizer suggestions');
    expect(result.pasteBundle).toContain('Standard_B2s');

    const idsSecret = result.secrets.find((s) => s.name === 'identifiers');
    expect(idsSecret).toBeDefined();

    const atkSpawns = mocks.recorder
      .byKind('spawn')
      .filter((c) => typeof c.target === 'string' && c.target.includes('atk'));
    expect(atkSpawns.length).toBeGreaterThan(0);
  });
});
