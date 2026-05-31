#!/usr/bin/env -S node --experimental-strip-types --experimental-transform-types --no-warnings
/**
 * Multi-terminal orchestrator demo.
 *
 * Spawns 4 named workers in a tmux session and polls each worker's pane
 * every 2s, writing a synthesized status log to stdout. Exits cleanly when
 * all workers complete.
 *
 *   pnpm --filter @app-factory/orchestrator demo:multi-terminal
 *
 *   # equivalently, from the repo root:
 *   node --experimental-strip-types --experimental-transform-types \
 *        --no-warnings tools/multi-terminal-demo.ts
 *   node --experimental-strip-types --experimental-transform-types \
 *        --no-warnings tools/multi-terminal-demo.ts --kill az
 *
 * Watch live:    tmux attach -t app-factory
 *
 * Local-only: no Azure/M365/Power Platform state is touched.
 */
// Relative import: the repo root does not own @app-factory/orchestrator
// as a dependency (workspace packages do), so pointing at the package
// source via a .ts specifier keeps the demo resolvable under both
// `pnpm tsx ...` and `node --experimental-strip-types ...`.
import { spawn, type WorkerHandle } from '../packages/orchestrator/src/tmux.ts';

interface WorkerSpec {
  name: string;
  /** Shell loop that emits progress lines then a DONE marker. */
  script: string;
}

// Each worker echoes "[name] step i/N" lines then a final "[name] FINISHED"
// line. We match the completion marker only when it appears as a standalone
// pane line — this avoids false positives from the command-echo that tmux
// shows on the line we typed via send().
function makeScript(name: string, steps: number): string {
  return (
    `for i in $(seq 1 ${steps}); do echo "[${name}] step $i/${steps}"; sleep 1; done; ` +
    `echo "[${name}] FINISHED"`
  );
}

function donePattern(name: string): RegExp {
  // Anchored to start-of-line + end-of-line (m flag): only a real echoed
  // output line matches, not the typed-command echo (which is one long line
  // that contains additional text after the marker).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\[${escaped}\\] FINISHED\\s*$`, 'm');
}

const WORKERS: WorkerSpec[] = [
  { name: 'pac', script: makeScript('pac', 5) },
  { name: 'atk', script: makeScript('atk', 6) },
  { name: 'az', script: makeScript('az', 4) },
  { name: 'gh-copilot', script: makeScript('gh-copilot', 7) },
];
const POLL_INTERVAL_MS = 2_000;
const SESSION = 'app-factory';

function parseArgs(argv: string[]): { killName?: string } {
  const out: { killName?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--kill') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--kill requires a worker name (e.g. --kill az)');
      }
      out.killName = next;
      i += 1;
    }
  }
  return out;
}

async function spawnWorker(spec: WorkerSpec): Promise<WorkerHandle> {
  const w = await spawn('bash', { session: SESSION, name: spec.name });
  // Send the actual workload after the shell is up. send() handles the Enter.
  await w.send(spec.script);
  return w;
}

function lastNonEmptyLine(buf: string): string {
  const lines = buf.split('\n').map((l) => l.trimEnd());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.length > 0) return line;
  }
  return '(no output)';
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\..+$/, '');
}

async function main(): Promise<void> {
  const { killName } = parseArgs(process.argv.slice(2));

  // eslint-disable-next-line no-console
  console.log(`[master ${timestamp()}] spawning ${WORKERS.length} workers in tmux session "${SESSION}"`);
  // eslint-disable-next-line no-console
  console.log(`[master ${timestamp()}] watch live with: tmux attach -t ${SESSION}`);

  const handles = new Map<string, WorkerHandle>();
  for (const spec of WORKERS) {
    const h = await spawnWorker(spec);
    handles.set(spec.name, h);
  }

  const completed = new Set<string>();
  let killedAlready = !killName;

  // Polling loop
  while (completed.size < WORKERS.length) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const statuses: string[] = [];
    for (const spec of WORKERS) {
      const h = handles.get(spec.name);
      if (!h) {
        statuses.push(`${spec.name}=MISSING`);
        continue;
      }
      let buf = '';
      try {
        buf = await h.capture(200);
      } catch (err) {
        statuses.push(`${spec.name}=ERR(${(err as Error).message})`);
        continue;
      }
      if (donePattern(spec.name).test(buf) && !completed.has(spec.name)) {
        completed.add(spec.name);
      }
      const tag = completed.has(spec.name) ? 'DONE' : 'run';
      statuses.push(`${spec.name}=${tag}:"${lastNonEmptyLine(buf).slice(-60)}"`);
    }
    // eslint-disable-next-line no-console
    console.log(`[master ${timestamp()}] ${statuses.join(' | ')}`);

    // One-shot: kill the requested worker, then respawn it to demonstrate recovery
    if (!killedAlready && killName) {
      const victim = handles.get(killName);
      if (!victim) {
        // eslint-disable-next-line no-console
        console.warn(`[master ${timestamp()}] --kill ${killName}: no such worker; valid names: ${[...handles.keys()].join(', ')}`);
        killedAlready = true;
      } else {
        // eslint-disable-next-line no-console
        console.log(`[master ${timestamp()}] killing worker "${killName}" to demo auto-respawn`);
        await victim.kill();
        completed.delete(killName);
        const spec = WORKERS.find((s) => s.name === killName);
        if (spec) {
          const fresh = await spawnWorker(spec);
          handles.set(killName, fresh);
          // eslint-disable-next-line no-console
          console.log(`[master ${timestamp()}] respawned "${killName}"`);
        }
        killedAlready = true;
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[master ${timestamp()}] all workers complete; cleaning up windows`);
  for (const h of handles.values()) {
    try {
      await h.kill();
    } catch {
      // already gone
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[master ${timestamp()}] exit ok`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('multi-terminal-demo failed:', err);
  process.exit(1);
});
