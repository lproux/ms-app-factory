import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger, PortalRequiredError } from '@app-factory/shared';

const log = createLogger('cs-resume');

// Same mock topology as `cs-happy-path.test.ts` so the CS pipeline runs
// against synthetic pac/Dataverse/judge responses. The deliberate twist:
// the second call to `pac env list` is the one we hijack to simulate the
// resume invocation re-running A2 unintentionally.
const mocks = vi.hoisted(() => {
  const calls: { kind: string; target: string; argv?: unknown[] }[] = [];
  let pacEnvListCount = 0;
  const recorder = {
    reset() {
      calls.length = 0;
      pacEnvListCount = 0;
    },
    record(c: { kind: string; target: string; argv?: unknown[] }) {
      calls.push(c);
    },
    pacEnvListCount() {
      return pacEnvListCount;
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
      if (args[0] === 'env' && args[1] === 'list') {
        pacEnvListCount++;
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              id: '11111111-2222-3333-4444-555555555555',
              displayName: 'Resume Test Env',
              url: 'https://orgmock.crm.dynamics.com',
              region: 'unitedstates',
              kind: 'Sandbox',
            },
          ]),
          stderr: '',
        };
      }
      if (args[0] === 'env' && args[1] === 'select') {
        return { exitCode: 0, stdout: 'Selected', stderr: '' };
      }
      if (args[0] === 'env' && args[1] === 'create') {
        return {
          exitCode: 0,
          stdout:
            'Created environment 11111111-2222-3333-4444-555555555555 at https://orgmock.crm.dynamics.com',
          stderr: '',
        };
      }
      if (args[0] === 'solution' && args[1] === 'import') {
        return {
          exitCode: 0,
          stdout: 'Solution Id 99999999-0000-1111-2222-333333333333 imported',
          stderr: '',
        };
      }
      if (args[0] === 'copilot' && args[1] === 'publish') {
        return { exitCode: 0, stdout: 'Copilot published', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (file === 'tmux') return { exitCode: 0, stdout: '', stderr: '' };
    if (file === 'gh') return { exitCode: 0, stdout: 'gh ok', stderr: '' };
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
      async send() {
        /* no-op */
      },
      async capture() {
        return '\n$ ';
      },
      async waitFor(pattern: RegExp) {
        if (/PAC_DONE/.test(pattern.source)) {
          return 'Solution Id 99999999-0000-1111-2222-333333333333 imported\nPAC_DONE=0\n';
        }
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
        reason: 'synthetic',
      };
    },
  });

  // Bot for A4: simulate PortalRequiredError on first call, success on second.
  let a4Throws = true;
  const setA4Behavior = (throws: boolean) => {
    a4Throws = throws;
  };
  const a4ShouldThrow = () => a4Throws;

  return {
    recorder,
    execaMock,
    spawnMock,
    fakeCredential,
    alwaysApprove,
    setA4Behavior,
    a4ShouldThrow,
  };
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

import { runCopilotStudio, copilotStudioSteps } from '@app-factory/copilot-studio';
import { FactoryContext } from '@app-factory/shared';
import { loadCheckpoint, saveCheckpoint } from '@app-factory/orchestrator';

let workdir: string;

beforeEach(async () => {
  mocks.recorder.reset();
  mocks.setA4Behavior(true);
  workdir = await mkdtemp(join(tmpdir(), 'af-cs-resume-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('Integration — Copilot Studio resume', () => {
  it('halts at A4 (PortalRequiredError), persists A2/A3 in checkpoint, then on resume skips A2/A3', async () => {
    // Hijack A4 to throw PortalRequiredError on the first invocation, then
    // succeed on the resume. We do this at the steps-array level rather
    // than via vi.mock so the original WBS metadata (deps, ids) is
    // preserved.
    const originalA4Run = copilotStudioSteps.find((s) => s.id === 'A4-entra-app')!.run;
    const stepA4 = copilotStudioSteps.find((s) => s.id === 'A4-entra-app')!;
    stepA4.run = async (ctx) => {
      if (mocks.a4ShouldThrow()) {
        throw new PortalRequiredError(
          'A4 demands portal step for Entra app',
          'https://entra.microsoft.com',
        );
      }
      await originalA4Run(ctx);
    };

    try {
      const fctx = FactoryContext.parse({
        runId: 'resume-test-001',
        recipe: 'copilot-studio-support-bot',
        planOnly: false,
        workdir,
        brand: { name: 'Resume Acme', greeting: 'hello' },
        kbSources: [],
        tenant: {
          tenantId: 'tenant-mock',
          powerPlatformEnvironment: 'new',
          region: 'unitedstates',
        },
      });

      // First run: halts at A4.
      const first = await runCopilotStudio(fctx);
      expect(first.ok).toBe(false);
      expect(first.errors.join(' ')).toMatch(/portal/i);

      // The checkpoint should contain A2 + A3 as completed and persist
      // their stepArtifacts so resume can rehydrate ctx.
      const cp = await loadCheckpoint(workdir);
      expect(cp).not.toBeNull();
      expect(cp!.completedStepIds).toEqual(
        expect.arrayContaining(['A2-resolve-environment', 'A3-solution-skeleton']),
      );
      expect(cp!.completedStepIds).not.toContain('A4-entra-app');
      const a2 = cp!.stepArtifacts?.['A2-resolve-environment'] as
        | { environment?: { id?: string; url?: string } }
        | undefined;
      expect(a2?.environment?.id).toBe('11111111-2222-3333-4444-555555555555');
      const a3 = cp!.stepArtifacts?.['A3-solution-skeleton'] as
        | { solutionDir?: string; solutionZip?: string }
        | undefined;
      expect(a3?.solutionDir).toBeTruthy();
      expect(a3?.solutionZip).toBeTruthy();

      // Record how many times `pac env list` ran during the first attempt.
      const pacListsAfterFirst = mocks.recorder.pacEnvListCount();
      expect(pacListsAfterFirst).toBeGreaterThan(0);

      // Resume: A4 now succeeds. A2/A3 must be skipped — i.e. pac env list
      // count must NOT increment.
      mocks.setA4Behavior(false);
      const resumeCtx = FactoryContext.parse({
        runId: 'resume-test-001',
        recipe: 'copilot-studio-support-bot',
        planOnly: false,
        workdir,
        brand: { name: 'Resume Acme', greeting: 'hello' },
        kbSources: [],
        tenant: {
          tenantId: 'tenant-mock',
          powerPlatformEnvironment: 'new',
          region: 'unitedstates',
        },
        resumeFromCheckpoint: cp ?? undefined,
      });
      const second = await runCopilotStudio(resumeCtx);
      log.info({ ok: second.ok, errors: second.errors }, 'resume complete');

      // A2's pac env list was NOT re-invoked on resume.
      expect(mocks.recorder.pacEnvListCount()).toBe(pacListsAfterFirst);
      // The resumed run got past A4 and completed at least through B/C
      // chained steps (no top-level PortalRequiredError surfaced).
      expect(second.errors.find((e) => /portal/i.test(e))).toBeUndefined();

      // Final checkpoint should now have A4 marked done too.
      const cp2 = await loadCheckpoint(workdir);
      expect(cp2!.completedStepIds).toContain('A4-entra-app');
    } finally {
      // Restore the original A4 run so other tests in the same vitest
      // process aren't poisoned.
      stepA4.run = originalA4Run;
    }
  });

  it('CLI_RESUME_NOT_FOUND error fires when no state.json exists for the runId', async () => {
    const { run } = await import('@app-factory/cli');
    const otherWorkdir = await mkdtemp(join(tmpdir(), 'af-cs-resume-empty-'));
    try {
      await expect(
        run({
          recipe: 'copilot-studio-support-bot',
          workdir: otherWorkdir,
          resume: 'no-such-run',
          nonInteractive: true,
        }),
      ).rejects.toMatchObject({ code: 'CLI_RESUME_NOT_FOUND' });
    } finally {
      await rm(otherWorkdir, { recursive: true, force: true });
    }
  });

  it('saveCheckpoint + loadCheckpoint round-trip in a workdir works end-to-end', async () => {
    const cp = {
      runId: 'rt-1',
      recipe: 'copilot-studio-support-bot',
      completedStepIds: ['A2-resolve-environment'],
      stepArtifacts: { 'A2-resolve-environment': { environment: { id: 'env-x' } } },
      savedAt: new Date().toISOString(),
    };
    await saveCheckpoint(workdir, cp);
    const loaded = await loadCheckpoint(workdir);
    expect(loaded).toEqual(cp);
  });
});
