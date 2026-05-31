import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks = vi.hoisted(() => {
  const calls: { kind: string; target: string; argv?: unknown[]; url?: string; method?: string }[] = [];
  const recorder = {
    reset() {
      calls.length = 0;
    },
    record(c: { kind: string; target: string; argv?: unknown[]; url?: string; method?: string }) {
      calls.push(c);
    },
    byKind(k: string) {
      return calls.filter((c) => c.kind === k);
    },
    all() {
      return calls;
    },
  };

  // Plan mode must NEVER fire these; if anything does, we record it loudly so
  // assertions blow up. execa returns a benign result so we still see *any*
  // call; spawn does the same. fetch THROWS.
  const execaMock = async (file: string, args: string[] = []) => {
    recorder.record({ kind: 'execa', target: file, argv: args });
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const spawnMock = async (
    command: string,
    spawnOpts: { name?: string; session?: string } = {},
  ) => {
    recorder.record({ kind: 'spawn', target: command, argv: [spawnOpts] });
    return {
      id: 'plan-fake',
      session: spawnOpts.session ?? 'app-factory',
      window: spawnOpts.name ?? 'plan',
      command,
      async send() {},
      async capture() {
        return '';
      },
      async waitFor() {
        return '';
      },
      async kill() {},
    };
  };
  const forbiddenFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : (input as Request).url;
    const method = init?.method ?? 'GET';
    recorder.record({ kind: 'http', target: 'fetch-forbidden', url, method });
    throw new Error(`PLAN_MODE_FETCH_FORBIDDEN: ${method} ${url}`);
  }) as unknown as typeof fetch;

  return { recorder, execaMock, spawnMock, forbiddenFetch };
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

import { run } from '@app-factory/cli';

let workdir: string;

beforeEach(async () => {
  mocks.recorder.reset();
  vi.stubGlobal('fetch', mocks.forbiddenFetch);
  workdir = await mkdtemp(join(tmpdir(), 'af-plan-'));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(workdir, { recursive: true, force: true });
});

describe('Integration — plan-mode parity', () => {
  it('Copilot Studio --plan writes a complete plan.md and triggers ZERO outgoing HTTP/CLI calls', async () => {
    const result = await run({
      recipe: 'copilot-studio-support-bot',
      plan: true,
      workdir,
      answers: {
        name: 'PlanOnly Bot',
        purpose: 'Triage L1',
        audience: 'Internal',
        environment: 'new',
        channels: ['teams'],
      },
      nonInteractive: true,
    });

    expect(result.ok).toBe(true);
    expect(result.log).toMatch(/plan\.md$/);

    const planMd = await readFile(result.log, 'utf8');
    expect(planMd).toContain('# Plan — Copilot Studio — Support Bot');
    expect(planMd).toContain('## Inputs');
    expect(planMd).toContain('## WBS — Copilot Studio (WBS A)');
    expect(planMd).toContain('A2-resolve-environment');
    expect(planMd).toContain('A12-emit-secrets');

    expect(mocks.recorder.byKind('execa')).toHaveLength(0);
    expect(mocks.recorder.byKind('spawn')).toHaveLength(0);
    expect(mocks.recorder.byKind('http')).toHaveLength(0);
  });

  it('Teams --plan writes a complete plan.md with WBS B steps and zero side effects', async () => {
    const result = await run({
      recipe: 'teams-bot-basic',
      plan: true,
      workdir,
      answers: {
        name: 'PlanOnly Teams Bot',
        purpose: 'Help desk',
        subscription: 'default',
        resourceGroup: 'rg-plan-only',
        region: 'eastus',
        capabilities: ['bot'],
      },
      nonInteractive: true,
    });

    expect(result.ok).toBe(true);
    const planMd = await readFile(result.log, 'utf8');
    expect(planMd).toContain('# Plan — Teams — Basic Bot');
    expect(planMd).toContain('## WBS — Teams App (WBS B)');
    expect(planMd).toContain('B2-scaffold');
    expect(planMd).toContain('B14-emit-secrets');

    expect(mocks.recorder.byKind('execa')).toHaveLength(0);
    expect(mocks.recorder.byKind('spawn')).toHaveLength(0);
    expect(mocks.recorder.byKind('http')).toHaveLength(0);
  });
});
