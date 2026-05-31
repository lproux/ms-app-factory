import { callRecorder } from './call-recorder.js';

/**
 * Build a no-op WorkerHandle compatible with `@app-factory/orchestrator`. The
 * fake handle returns a canned buffer when `capture()` or `waitFor()` is
 * called, so downstream parsers (pac solution import, atk done markers) see
 * "success" patterns.
 *
 * Match the WorkerHandle shape from packages/orchestrator/src/tmux.ts.
 */
export interface FakeHandle {
  id: string;
  session: string;
  window: string;
  command: string;
  send: (keys: string, enter?: boolean) => Promise<void>;
  capture: (lines?: number) => Promise<string>;
  waitFor: (
    pattern: RegExp,
    opts?: { timeoutMs?: number; pollMs?: number },
  ) => Promise<string>;
  kill: () => Promise<void>;
}

export interface SpawnFakeOptions {
  /** Output the fake handle returns on capture/waitFor. */
  outputs?: Map<RegExp, string>;
  /** Default output if no regex matches. */
  defaultOutput?: string;
}

const DEFAULT_OUTPUTS = new Map<RegExp, string>([
  // atk wrapper waits for [atk-done:N]
  [/\[atk-done:\d+\]/, 'all subtasks completed\n[atk-done:0]\n'],
  // pac solution import wraps in `; echo PAC_DONE=$?`
  [/PAC_DONE=(\d+)/, 'Solution Id 99999999-0000-1111-2222-333333333333 imported\nPAC_DONE=0\n'],
  // git clone fallback
  [/GIT_DONE=(\d+)/, 'GIT_DONE=0\n'],
  // gh version probe (used by gh-copilot judge)
  [/gh version|GH_COPILOT|\$\s*$/i, 'gh version 2.50.0 (mock)\n$ '],
  // PIM activation
  [/Role activation succeeded|already active|active for|\[pim\] activation step finished/i, '[pim] activation step finished'],
]);

export function makeSpawnMock(opts: SpawnFakeOptions = {}): (
  command: string,
  spawnOpts?: { name?: string; session?: string; cwd?: string; env?: Record<string, string | undefined> },
) => Promise<FakeHandle> {
  const outputs = opts.outputs ?? DEFAULT_OUTPUTS;
  const defaultOutput = opts.defaultOutput ?? '\n$ ';

  let counter = 0;

  return async function spawnMock(
    command: string,
    spawnOpts: { name?: string; session?: string; cwd?: string } = {},
  ): Promise<FakeHandle> {
    const id = `fake-${++counter}`;
    callRecorder.record({ kind: 'spawn', target: command, argv: [spawnOpts] });

    const handle: FakeHandle = {
      id,
      session: spawnOpts.session ?? 'app-factory',
      window: spawnOpts.name ?? `w-${id}`,
      command,
      async send(_keys: string, _enter?: boolean): Promise<void> {
        // no-op
      },
      async capture(_lines?: number): Promise<string> {
        return matchOutput(command, outputs, defaultOutput);
      },
      async waitFor(pattern: RegExp): Promise<string> {
        // Return canned output that matches the requested pattern when possible.
        for (const [rx, out] of outputs) {
          if (rx.source === pattern.source || pattern.test(out)) {
            return out;
          }
        }
        // Even if no output matches the requested pattern, still return canned
        // output so callers can extract their own substrings.
        return matchOutput(command, outputs, defaultOutput);
      },
      async kill(): Promise<void> {
        // no-op
      },
    };
    return handle;
  };
}

function matchOutput(
  command: string,
  outputs: Map<RegExp, string>,
  defaultOutput: string,
): string {
  for (const [rx, out] of outputs) {
    if (rx.test(command)) return out;
  }
  return defaultOutput;
}

/**
 * No-op `ensureSession`.
 */
export async function ensureSessionStub(_name?: string): Promise<void> {
  // no-op
}
