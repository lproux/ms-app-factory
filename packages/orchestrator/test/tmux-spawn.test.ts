import { afterAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { nanoid } from 'nanoid';
import { spawn, type WorkerHandle } from '../src/tmux.js';

async function hasTmux(): Promise<boolean> {
  try {
    const r = await execa('tmux', ['-V'], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

const tmuxAvailable = await hasTmux();

const describeIfTmux = tmuxAvailable
  ? describe
  : describe.skip;

if (!tmuxAvailable) {
  // Surfaced clearly in test reporter output
  // eslint-disable-next-line no-console
  console.warn('[tmux-spawn] tmux is not installed on PATH — skipping orchestrator tmux integration tests.');
}

describeIfTmux('orchestrator tmux spawn/supervise', () => {
  const sessionName = `app-factory-test-${nanoid(6)}`;
  const workers: WorkerHandle[] = [];

  afterAll(async () => {
    // Best-effort cleanup of every window we know about, then the whole session
    for (const w of workers) {
      try {
        await w.kill();
      } catch {
        // window may already be gone; ignore
      }
    }
    try {
      await execa('tmux', ['kill-session', '-t', sessionName], { reject: false });
    } catch {
      // session may already be gone; ignore
    }
  });

  it('spawns 3 worker windows in a uniquely-named session and captures READY', async () => {
    for (let i = 0; i < 3; i += 1) {
      const w = await spawn('bash', { session: sessionName, name: `worker-${i}` });
      workers.push(w);
    }
    expect(workers).toHaveLength(3);

    for (const w of workers) {
      await w.send('echo READY');
      const buf = await w.waitFor(/READY/, { timeoutMs: 30_000, pollMs: 500 });
      expect(buf).toMatch(/READY/);
    }

    // Capture-pane sanity: independently re-read and confirm READY persists
    for (const w of workers) {
      const buf = await w.capture(200);
      expect(buf).toMatch(/READY/);
    }
  });

  it('kill() removes the window and a fresh spawn() re-spawns cleanly', async () => {
    const victim = workers[0];
    expect(victim).toBeDefined();
    if (!victim) return;
    const killedName = victim.window;
    await victim.kill();

    // Window should be gone
    const list = await execa(
      'tmux',
      ['list-windows', '-t', sessionName, '-F', '#{window_name}'],
      { reject: false },
    );
    expect(list.stdout.split('\n')).not.toContain(killedName);

    // Re-spawn with the same name; should succeed and respond to send/waitFor
    const respawned = await spawn('bash', { session: sessionName, name: killedName });
    workers[0] = respawned;
    await respawned.send('echo RESPAWNED');
    const buf = await respawned.waitFor(/RESPAWNED/, { timeoutMs: 30_000, pollMs: 500 });
    expect(buf).toMatch(/RESPAWNED/);
  });
});
