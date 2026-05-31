import { callRecorder } from './call-recorder.js';

/**
 * Canned response payloads for the CLIs we intercept. Each handler matches a
 * `[binary, argv...]` shape and returns a fake `execa` result.
 */
export interface FakeExecaResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

type Handler = (file: string, args: string[]) => FakeExecaResult | undefined;

const HANDLERS: Handler[] = [
  // pac
  (file, args) => {
    if (file !== 'pac') return undefined;
    if (args[0] === 'help') {
      return {
        exitCode: 0,
        stdout: 'pac (mock) — copilot, solution, env, auth, connector subcommands available',
        stderr: '',
      };
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
    if (args[0] === 'solution' && args[1] === 'init') {
      return { exitCode: 0, stdout: 'Solution initialized', stderr: '' };
    }
    if (args[0] === 'solution' && args[1] === 'import') {
      return {
        exitCode: 0,
        stdout: 'Solution Id 99999999-0000-1111-2222-333333333333 imported successfully',
        stderr: '',
      };
    }
    if (args[0] === 'solution' && args[1] === 'publish') {
      return { exitCode: 0, stdout: 'Solution published', stderr: '' };
    }
    if (args[0] === 'copilot' && args[1] === 'publish') {
      return { exitCode: 0, stdout: 'Copilot published', stderr: '' };
    }
    if (args[0] === 'connector' && args[1] === 'create') {
      return { exitCode: 0, stdout: 'Connector created', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  },
  // atk — version check
  (file, args) => {
    if (file !== 'atk') return undefined;
    if (args[0] === '--version') {
      return { exitCode: 0, stdout: '3.1.0', stderr: '' };
    }
    return { exitCode: 0, stdout: 'atk ok', stderr: '' };
  },
  // az
  (file, _args) => {
    if (file !== 'az') return undefined;
    return { exitCode: 0, stdout: '{}', stderr: '' };
  },
  // gh
  (file, args) => {
    if (file !== 'gh') return undefined;
    if (args[0] === '--version') {
      return { exitCode: 0, stdout: 'gh version 2.50.0 (mock)', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  },
  // tmux (orchestrator/tmux.ts uses execa for tmux too)
  (file, args) => {
    if (file !== 'tmux') return undefined;
    if (args[0] === 'has-session') return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  },
];

/**
 * Build a vi.fn-compatible execa replacement. Records every call.
 *
 * The real `execa` returns a promise that, on `await`, resolves to a result
 * with `exitCode/stdout/stderr` (when `reject: false`) — we match that shape.
 */
export function makeExecaMock(): (
  file: string,
  args?: string[],
  _opts?: Record<string, unknown>,
) => Promise<FakeExecaResult> {
  return async function execaMock(
    file: string,
    args: string[] = [],
    _opts: Record<string, unknown> = {},
  ): Promise<FakeExecaResult> {
    callRecorder.record({ kind: 'execa', target: file, argv: args });
    for (const h of HANDLERS) {
      const r = h(file, args);
      if (r) return r;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}
