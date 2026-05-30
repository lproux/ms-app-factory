import { execa } from 'execa';
import { nanoid } from 'nanoid';
import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('orchestrator:tmux');

const TMUX = 'tmux';
const DEFAULT_SESSION = 'app-factory';

async function tmux(args: string[]): Promise<string> {
  const result = await execa(TMUX, args, { reject: false });
  if (result.exitCode !== 0) {
    throw new AppFactoryError('TMUX', `tmux ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export async function ensureSession(name: string = DEFAULT_SESSION): Promise<void> {
  const r = await execa(TMUX, ['has-session', '-t', name], { reject: false });
  if (r.exitCode === 0) return;
  await tmux(['new-session', '-d', '-s', name, '-x', '220', '-y', '50']);
  log.info({ session: name }, 'tmux session created');
}

export interface WorkerHandle {
  id: string;
  session: string;
  window: string;
  command: string;
  send(keys: string, enter?: boolean): Promise<void>;
  capture(lines?: number): Promise<string>;
  waitFor(pattern: RegExp, opts?: { timeoutMs?: number; pollMs?: number }): Promise<string>;
  kill(): Promise<void>;
}

export interface SpawnOptions {
  name?: string;
  session?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function spawn(command: string, opts: SpawnOptions = {}): Promise<WorkerHandle> {
  const session = opts.session ?? DEFAULT_SESSION;
  await ensureSession(session);
  const id = nanoid(8);
  const window = opts.name ?? `w-${id}`;

  const envPrefix = opts.env
    ? Object.entries(opts.env)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${shellEscape(v as string)}`)
        .join(' ')
    : '';
  const cwdPrefix = opts.cwd ? `cd ${shellEscape(opts.cwd)} && ` : '';
  const fullCmd = `${cwdPrefix}${envPrefix ? envPrefix + ' ' : ''}${command}`;

  await tmux(['new-window', '-t', session, '-n', window, '-d', fullCmd]);
  log.info({ session, window, command }, 'worker spawned');

  const handle: WorkerHandle = {
    id,
    session,
    window,
    command,
    async send(keys: string, enter = true) {
      const args = ['send-keys', '-t', `${session}:${window}`, keys];
      if (enter) args.push('Enter');
      await tmux(args);
    },
    async capture(lines = 500) {
      return tmux(['capture-pane', '-t', `${session}:${window}`, '-p', '-S', `-${lines}`]);
    },
    async waitFor(pattern, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 120_000;
      const pollMs = opts.pollMs ?? 1_000;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const buf = await this.capture(2000);
        const m = pattern.exec(buf);
        if (m) return buf;
        await new Promise((r) => setTimeout(r, pollMs));
      }
      throw new AppFactoryError('TMUX_WAIT_TIMEOUT', `pattern ${pattern} not seen in ${timeoutMs}ms`, {
        details: { window, pattern: pattern.source },
      });
    },
    async kill() {
      await tmux(['kill-window', '-t', `${session}:${window}`]);
    },
  };
  return handle;
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
