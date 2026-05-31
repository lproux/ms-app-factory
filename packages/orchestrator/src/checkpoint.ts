import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('orchestrator:checkpoint');

/**
 * Persisted resume marker for a single factory run.
 *
 * Lives at `<workdir>/state.json`. The orchestrator writes this file after
 * every step completes; a `--resume <runId>` invocation rehydrates it before
 * the WBS executor starts, so completed steps are skipped and dependent
 * steps see the same ctx state they would have seen had the run never
 * halted.
 */
export interface Checkpoint {
  runId: string;
  recipe: string;
  completedStepIds: string[];
  /**
   * Per-step opaque payload (resumable state). Keyed by step id. Only
   * steps whose output is needed by downstream steps should populate this;
   * transient log lines must NOT be persisted.
   */
  stepArtifacts?: Record<string, unknown>;
  savedAt: string;
}

const CHECKPOINT_FILENAME = 'state.json';

/** Resolve the canonical checkpoint file path for a given workdir. */
export function checkpointPath(workdir: string): string {
  return path.join(workdir, CHECKPOINT_FILENAME);
}

/**
 * Load a checkpoint from `<workdir>/state.json`. Returns `null` if the file
 * does not exist (fresh runs). Throws `AppFactoryError(CHECKPOINT_CORRUPT)`
 * when the file exists but cannot be parsed — the user can delete it and
 * start fresh.
 */
export async function loadCheckpoint(workdir: string): Promise<Checkpoint | null> {
  const file = checkpointPath(workdir);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw new AppFactoryError('CHECKPOINT_READ_FAILED', `cannot read checkpoint at ${file}: ${e.message}`, {
      cause: err,
      details: { file },
    });
  }
  try {
    const parsed = JSON.parse(raw) as Checkpoint;
    if (
      typeof parsed.runId !== 'string' ||
      typeof parsed.recipe !== 'string' ||
      !Array.isArray(parsed.completedStepIds)
    ) {
      throw new AppFactoryError('CHECKPOINT_CORRUPT', `checkpoint at ${file} is missing required fields`, {
        details: { file },
      });
    }
    return parsed;
  } catch (err) {
    if (err instanceof AppFactoryError) throw err;
    throw new AppFactoryError('CHECKPOINT_CORRUPT', `cannot parse checkpoint at ${file}: ${(err as Error).message}`, {
      cause: err,
      details: { file },
    });
  }
}

/**
 * Atomically persist a checkpoint to `<workdir>/state.json`. Writes to a
 * temp file in the same directory then renames, so a crash mid-write never
 * leaves a torn JSON file on disk.
 */
export async function saveCheckpoint(workdir: string, cp: Checkpoint): Promise<void> {
  const file = checkpointPath(workdir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(workdir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(cp, null, 2), 'utf8');
    await fs.rename(tmp, file);
    log.debug({ file, runId: cp.runId, completed: cp.completedStepIds.length }, 'checkpoint saved');
  } catch (err) {
    // Best-effort cleanup of the temp file; ignore unlink errors.
    try {
      await fs.unlink(tmp);
    } catch {
      /* swallow */
    }
    throw new AppFactoryError(
      'CHECKPOINT_WRITE_FAILED',
      `cannot save checkpoint at ${file}: ${(err as Error).message}`,
      { cause: err, details: { file } },
    );
  }
}
