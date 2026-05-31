import { AppFactoryError, createLogger, span } from '@app-factory/shared';
import type { Checkpoint } from './checkpoint.js';

const log = createLogger('orchestrator:wbs');

export interface Step<C> {
  id: string;
  description: string;
  parallelGroup?: string;
  dependsOn?: string[];
  run: (ctx: C) => Promise<void>;
}

export interface RunOptions {
  planOnly?: boolean;
  onStep?: (id: string, phase: 'start' | 'done' | 'fail', err?: Error) => void;
  /**
   * Workdir associated with the run. The WBS executor itself does not write
   * to disk; this lives here so callers (and `onCheckpoint`) can correlate
   * filesystem locations with the executing run.
   */
  workdir?: string;
  /**
   * A previously-loaded checkpoint. When provided, every step id in
   * `completedStepIds` is seeded into the `done` set BEFORE the loop, so
   * those steps' `run` callbacks are never invoked. Hydration of ctx
   * fields from `stepArtifacts` is the caller's responsibility — it must
   * happen before `execute` is called.
   */
  resumeFromCheckpoint?: Checkpoint | null;
  /**
   * Called after a step completes successfully. Receives an immutable
   * snapshot of the current checkpoint (runId, recipe, completedStepIds,
   * stepArtifacts). The caller persists it however it wants (typically
   * via `saveCheckpoint`). Errors thrown here are logged but do NOT halt
   * the WBS — losing a checkpoint write is preferable to losing a
   * successful step.
   */
  onCheckpoint?: (cp: Checkpoint) => Promise<void>;
  /**
   * runId / recipe identity for checkpoint writes when no
   * `resumeFromCheckpoint` is supplied (i.e. first run). Required to
   * persist a fresh checkpoint; without them `onCheckpoint` is treated as
   * a no-op for fresh runs.
   */
  runId?: string;
  recipe?: string;
  /**
   * Optional hook called BEFORE the WBS loop starts, when resuming from a
   * checkpoint. Receives `stepArtifacts` so the caller can hydrate ctx
   * fields (e.g. environment, solutionDir) before any dependent step runs.
   */
  hydrateFromCheckpoint?: (stepArtifacts: Record<string, unknown>) => void | Promise<void>;
  /**
   * Optional hook called AFTER a step completes successfully. Returns the
   * payload (if any) to persist into `stepArtifacts[id]` for this step.
   * Steps with no resumable state should return `undefined`. The executor
   * itself is ctx-shape-agnostic; this hook is where callers project the
   * resumable subset out of ctx.
   */
  collectStepArtifacts?: (id: string, ctx: unknown) => unknown;
}

export async function execute<C>(steps: Step<C>[], ctx: C, opts: RunOptions = {}): Promise<void> {
  const done = new Set<string>();
  if (opts.planOnly) {
    for (const s of steps) {
      log.info({ id: s.id, parallelGroup: s.parallelGroup, dependsOn: s.dependsOn }, s.description);
    }
    return;
  }

  // Resume support: seed the done set with previously-completed step ids
  // BEFORE the loop. Ids not present in the current step list are simply
  // ignored (recipe drift between runs is tolerated). Step `run` callbacks
  // for resumed ids are NEVER invoked — the caller is expected to have
  // hydrated the relevant ctx fields from `resumeFromCheckpoint.stepArtifacts`
  // (either before calling `execute`, or via `hydrateFromCheckpoint`).
  const checkpoint = opts.resumeFromCheckpoint ?? null;
  const stepIds = new Set(steps.map((s) => s.id));
  if (checkpoint) {
    for (const id of checkpoint.completedStepIds) {
      if (stepIds.has(id)) {
        done.add(id);
        log.info({ id, action: 'resume-skip' }, `resume: skipping completed step ${id}`);
      }
    }
    if (opts.hydrateFromCheckpoint && checkpoint.stepArtifacts) {
      await opts.hydrateFromCheckpoint(checkpoint.stepArtifacts);
    }
  }

  // Mutable checkpoint state for in-flight saves. Seeded from the resumed
  // checkpoint so we don't lose stepArtifacts persisted on a prior run.
  // The `onCheckpoint` callback may mutate `stepArtifacts` in-place via the
  // snapshot it receives, but the canonical model is: the caller reads ctx
  // and returns a fresh `stepArtifacts` map, or appends to the snapshot.
  const stepArtifacts: Record<string, unknown> = { ...(checkpoint?.stepArtifacts ?? {}) };
  const runId = checkpoint?.runId ?? opts.runId;
  const recipe = checkpoint?.recipe ?? opts.recipe;

  /**
   * Public hook for steps that produced resumable state: merge into the
   * in-memory stepArtifacts map. The merge is intentionally simple: the
   * caller writes `setStepArtifact(id, payload)` and the persisted file
   * picks it up on the next `persist` call.
   *
   * Exposed via a closure so step `run` callbacks can call back into the
   * executor without us widening the Step contract.
   */
  const persist = async (justFinishedId: string): Promise<void> => {
    if (!opts.onCheckpoint || !runId || !recipe) return;
    const cp: Checkpoint = {
      runId,
      recipe,
      completedStepIds: Array.from(done),
      stepArtifacts: { ...stepArtifacts },
      savedAt: new Date().toISOString(),
    };
    try {
      await opts.onCheckpoint(cp);
    } catch (err) {
      // Never fail the WBS for a checkpoint write — log & move on.
      log.warn({ id: justFinishedId, err: (err as Error).message }, 'checkpoint persist failed');
    }
  };

  while (done.size < steps.length) {
    const ready = steps.filter(
      (s) => !done.has(s.id) && (s.dependsOn ?? []).every((d) => done.has(d)),
    );
    if (ready.length === 0) {
      const missing = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw new AppFactoryError('WBS_DEADLOCK', `cannot resolve dependencies for: ${missing.join(', ')}`);
    }

    // Fan out ALL ready steps in parallel. Steps that share a `parallelGroup`
    // value behave the same as steps with distinct ids — Promise.all over the
    // flat list runs them concurrently while still honouring `dependsOn`.
    // Previously only the first group ran per round, which serialized any
    // recipe that hadn't manually unified its parallelGroup keys.
    await Promise.all(
      ready.map((s) =>
        span(`step:${s.id}`, async () => {
          opts.onStep?.(s.id, 'start');
          try {
            await s.run(ctx);
            done.add(s.id);
            opts.onStep?.(s.id, 'done');
            // Collect step artifacts (resumable state) from ctx before
            // persisting. Steps with no resumable state return undefined.
            if (opts.collectStepArtifacts) {
              const payload = opts.collectStepArtifacts(s.id, ctx);
              if (payload !== undefined) stepArtifacts[s.id] = payload;
            }
            // Persist a checkpoint as soon as the step is marked done. We
            // do this inside the parallel map so concurrent steps each
            // write their own checkpoint snapshot; the LAST writer wins,
            // which is fine — `completedStepIds` is monotonic per run.
            await persist(s.id);
          } catch (err) {
            opts.onStep?.(s.id, 'fail', err as Error);
            throw err;
          }
        }),
      ),
    );
  }
}
