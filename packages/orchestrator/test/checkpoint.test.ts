import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCheckpoint, saveCheckpoint, checkpointPath, type Checkpoint } from '../src/index.js';
import { AppFactoryError } from '@app-factory/shared';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'af-cp-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('checkpoint — load/save', () => {
  it('returns null when no state.json exists', async () => {
    const cp = await loadCheckpoint(workdir);
    expect(cp).toBeNull();
  });

  it('round-trips a checkpoint through save → load', async () => {
    const cp: Checkpoint = {
      runId: 'abc-123',
      recipe: 'copilot-studio-support-bot',
      completedStepIds: ['A2-resolve-environment', 'A3-solution-skeleton'],
      stepArtifacts: { 'A2-resolve-environment': { id: 'env-1', url: 'https://orgmock.crm.dynamics.com' } },
      savedAt: new Date().toISOString(),
    };
    await saveCheckpoint(workdir, cp);
    const loaded = await loadCheckpoint(workdir);
    expect(loaded).toEqual(cp);
  });

  it('writes atomically: temp file gets renamed, no .tmp left over', async () => {
    const cp: Checkpoint = {
      runId: 'r',
      recipe: 'teams-bot-basic',
      completedStepIds: [],
      savedAt: new Date().toISOString(),
    };
    await saveCheckpoint(workdir, cp);
    const file = checkpointPath(workdir);
    const text = await readFile(file, 'utf8');
    expect(JSON.parse(text).runId).toBe('r');
    // no stray tmp files in the dir
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(workdir);
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
  });

  it('rejects corrupt JSON with AppFactoryError(CHECKPOINT_CORRUPT)', async () => {
    await mkdir(workdir, { recursive: true });
    await writeFile(checkpointPath(workdir), '{not valid json', 'utf8');
    await expect(loadCheckpoint(workdir)).rejects.toMatchObject({
      code: 'CHECKPOINT_CORRUPT',
    });
  });

  it('rejects checkpoint missing required fields', async () => {
    await mkdir(workdir, { recursive: true });
    await writeFile(checkpointPath(workdir), JSON.stringify({ runId: 'x' }), 'utf8');
    await expect(loadCheckpoint(workdir)).rejects.toBeInstanceOf(AppFactoryError);
  });
});
