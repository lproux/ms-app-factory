import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '@app-factory/shared';

const log = createLogger('cs-happy-path');

// vi.mock factories are hoisted to the top of the file. They cannot reference
// non-hoisted variables. We use `vi.hoisted` to materialize the mock builders
// alongside the factories so the dist bundles of the system under test see
// the mocks as soon as they `import { execa } from 'execa'`.
const mocks = vi.hoisted(() => {
  // Re-implement the mock factories inline so they're available at hoist
  // time. Helpers in src/mocks/ remain useful for tests that don't need to
  // intercept dist-level imports.
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

  const execaMock = async (
    file: string,
    args: string[] = [],
    _opts: Record<string, unknown> = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    recorder.record({ kind: 'execa', target: file, argv: args });
    if (file === 'pac') {
      if (args[0] === 'help') {
        return { exitCode: 0, stdout: 'pac (mock) — copilot, solution, env, auth, connector', stderr: '' };
      }
      if (args[0] === 'env' && args[1] === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: '11111111-2222-3333-4444-555555555555',
              displayName: 'AppFactory Test Env',
              url: 'https://orgmock.crm.dynamics.com',
              region: 'unitedstates',
              kind: 'Sandbox',
            },
          ]),
          stderr: '',
        };
      }
      if (args[0] === 'env' && args[1] === 'create') {
        return {
          exitCode: 0,
          stdout:
            'Created environment 11111111-2222-3333-4444-555555555555 at https://orgmock.crm.dynamics.com',
          stderr: '',
        };
      }
      if (args[0] === 'env' && args[1] === 'select') {
        return { exitCode: 0, stdout: 'Selected environment', stderr: '' };
      }
      if (args[0] === 'solution' && args[1] === 'import') {
        return {
          exitCode: 0,
          stdout: 'Solution Id 99999999-0000-1111-2222-333333333333 imported successfully',
          stderr: '',
        };
      }
      if (args[0] === 'copilot' && args[1] === 'publish') {
        return { exitCode: 0, stdout: 'Copilot published', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (file === 'atk') {
      if (args[0] === '--version') return { exitCode: 0, stdout: '3.1.0', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (file === 'tmux') return { exitCode: 0, stdout: '', stderr: '' };
    if (file === 'gh') {
      if (args[0] === '--version') return { exitCode: 0, stdout: 'gh version 2.50.0 (mock)', stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    }
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
        // Return a canned line matching common patterns so callers can extract substrings.
        if (/PAC_DONE/.test(pattern.source)) {
          return 'Solution Id 99999999-0000-1111-2222-333333333333 imported\nPAC_DONE=0\n';
        }
        if (/atk-done/.test(pattern.source)) {
          return 'completed\n[atk-done:0]\n';
        }
        if (/GIT_DONE/.test(pattern.source)) return 'GIT_DONE=0\n';
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

// Stub the OS keyring so integration tests never touch the host backend.
// `@napi-rs/keyring` replaced the old `keytar` dependency (security/maint).
vi.mock('@napi-rs/keyring', () => ({
  Entry: class FakeEntry {
    constructor(public service: string, public account: string) {}
    setPassword(_value: string) {
      /* no-op */
    }
    getPassword() {
      return null;
    }
  },
}));

// -- Imports of the system under test happen AFTER mocks are declared -------

import { runCopilotStudio } from '@app-factory/copilot-studio';
import { FactoryContext } from '@app-factory/shared';

let workdir: string;

beforeEach(async () => {
  mocks.recorder.reset();
  workdir = await mkdtemp(join(tmpdir(), 'af-cs-happy-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('Integration — Copilot Studio happy path', () => {
  it('runs the full WBS A pipeline with the support-bot recipe and emits the paste bundle', async () => {
    const fctx = FactoryContext.parse({
      runId: 'cs-happy-001',
      recipe: 'copilot-studio-support-bot',
      planOnly: false,
      workdir,
      brand: { name: 'Acme Support', greeting: "Hi! I'm Acme Support." },
      kbSources: [],
      tenant: { tenantId: 'tenant-mock', powerPlatformEnvironment: 'new', region: 'unitedstates' },
    });

    const result = await runCopilotStudio(fctx);

    log.info({ ok: result.ok, runId: result.runId, errors: result.errors }, 'run complete');

    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);

    const kinds = new Set(result.artifacts.map((a) => a.kind));
    expect(kinds.has('azure-resource')).toBe(true); // environment
    expect(kinds.has('cs-agent')).toBe(true); // skeleton + published

    const secretNames = result.secrets.map((s) => s.name);
    expect(secretNames).toContain('envId');
    expect(secretNames).toContain('envUrl');
    expect(secretNames).toContain('agentId');
    expect(secretNames).toContain('invokeUrl');

    expect(result.pasteBundle).toContain('# App Factory — Copilot Studio run report');
    expect(result.pasteBundle).toContain('## Artifacts');
    expect(result.pasteBundle).toContain('## Secrets');
    expect(result.pasteBundle).toContain('## `.env` block');
    expect(result.pasteBundle).toContain('## clawpilot paste block');
    expect(result.pasteBundle).toContain('COPILOT_STUDIO__ENVID');
    expect(result.pasteBundle).toContain('COPILOT_STUDIO__AGENTID');

    const pacCalls = mocks.recorder.byKind('execa').filter((c) => c.target === 'pac');
    expect(pacCalls.length).toBeGreaterThan(0);
  });
});
