import { describe, expect, it } from 'vitest';
import { execute, type Step, type Checkpoint } from '../src/index.js';

interface FakeCtx {
  calls: string[];
  hydrated?: { from: Record<string, unknown> };
  payload?: string;
}

function threeStepGraph(): Step<FakeCtx>[] {
  return [
    {
      id: 's1',
      description: 'first',
      run: async (ctx) => {
        ctx.calls.push('s1');
      },
    },
    {
      id: 's2',
      description: 'second',
      dependsOn: ['s1'],
      run: async (ctx) => {
        ctx.calls.push('s2');
        ctx.payload = 's2-output';
      },
    },
    {
      id: 's3',
      description: 'third',
      dependsOn: ['s2'],
      run: async (ctx) => {
        ctx.calls.push('s3');
      },
    },
  ];
}

describe('wbs.execute — resume', () => {
  it('seeds done set from checkpoint.completedStepIds and skips those step.run callbacks', async () => {
    const steps = threeStepGraph();
    const ctx: FakeCtx = { calls: [] };
    const checkpoint: Checkpoint = {
      runId: 'r-1',
      recipe: 'copilot-studio-support-bot',
      completedStepIds: ['s2'], // s2 already done — must NOT be invoked
      stepArtifacts: { s2: { payload: 's2-output' } },
      savedAt: new Date().toISOString(),
    };

    await execute(steps, ctx, {
      resumeFromCheckpoint: checkpoint,
      hydrateFromCheckpoint: (artifacts) => {
        ctx.hydrated = { from: artifacts };
      },
    });

    // s2 was marked done; s1 must still run (it depends on nothing); s3
    // depends on s2 and runs after the resume seed.
    expect(ctx.calls).toContain('s1');
    expect(ctx.calls).not.toContain('s2');
    expect(ctx.calls).toContain('s3');
    expect(ctx.hydrated?.from).toEqual({ s2: { payload: 's2-output' } });
  });

  it('a fresh run with no checkpoint executes every step exactly once', async () => {
    const steps = threeStepGraph();
    const ctx: FakeCtx = { calls: [] };
    await execute(steps, ctx, {});
    expect(ctx.calls).toEqual(['s1', 's2', 's3']);
  });

  it('calls onCheckpoint after each successful step with collectStepArtifacts payload', async () => {
    const steps = threeStepGraph();
    const ctx: FakeCtx = { calls: [] };
    const saved: Checkpoint[] = [];
    await execute(steps, ctx, {
      runId: 'r-fresh',
      recipe: 'copilot-studio-support-bot',
      onCheckpoint: async (cp) => {
        saved.push(cp);
      },
      collectStepArtifacts: (id, c) => {
        const cc = c as FakeCtx;
        if (id === 's2') return { payload: cc.payload };
        return undefined;
      },
    });
    // Three steps → three checkpoint writes.
    expect(saved).toHaveLength(3);
    // Last checkpoint should contain s2's payload.
    const last = saved[saved.length - 1];
    expect(last).toBeDefined();
    expect(last?.stepArtifacts?.['s2']).toEqual({ payload: 's2-output' });
    expect(last?.completedStepIds).toEqual(expect.arrayContaining(['s1', 's2', 's3']));
  });

  it('checkpoint write errors are swallowed (do not halt WBS)', async () => {
    const steps = threeStepGraph();
    const ctx: FakeCtx = { calls: [] };
    await execute(steps, ctx, {
      runId: 'r-flaky',
      recipe: 'copilot-studio-support-bot',
      onCheckpoint: async () => {
        throw new Error('disk full');
      },
    });
    expect(ctx.calls).toEqual(['s1', 's2', 's3']);
  });
});
