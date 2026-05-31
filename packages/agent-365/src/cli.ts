import { execa, type Options as ExecaOptions } from 'execa';
import {
  AppFactoryError,
  PortalRequiredError,
  ProvisioningError,
  createLogger,
} from '@app-factory/shared';
import { spawn, type SpawnOptions, type WorkerHandle } from '@app-factory/orchestrator';

const log = createLogger('agent-365:cli');

export const MIN_AGENT365_VERSION = '0.1.0';
const AGENT365_BIN = 'agent365';
const AGENT365_PORTAL_URL =
  'https://learn.microsoft.com/microsoft-365/agents-sdk/agent-365-cli';
const INSTALL_HINT = 'npm i -g @microsoft/agent-365-cli';

export type Agent365SpawnFn = (
  command: string,
  opts?: SpawnOptions,
) => Promise<WorkerHandle>;

export type Agent365Exec = (
  file: string,
  args: string[],
  opts?: ExecaOptions,
) => ReturnType<typeof execa>;

let _verifiedVersion: string | undefined;

export interface DetectAgent365CliVersionOptions {
  exec?: Agent365Exec;
}

/**
 * Probe `agent365 --version`. On success, cache and return the version string.
 * On failure, surface a {@link PortalRequiredError} carrying the install hint
 * so callers can fall back to the portal-driven flow.
 */
export async function detectAgent365CliVersion(
  opts: DetectAgent365CliVersionOptions = {},
): Promise<string> {
  if (_verifiedVersion) return _verifiedVersion;
  const exec =
    opts.exec ??
    (execa as unknown as Agent365Exec);
  try {
    const result = await exec(AGENT365_BIN, ['--version'], { reject: false });
    if (result.exitCode !== 0) {
      throw new PortalRequiredError(
        `agent365 CLI not available (exit ${result.exitCode}). Install with: ${INSTALL_HINT}`,
        AGENT365_PORTAL_URL,
        {
          details: {
            stderr: result.stderr,
            stdout: result.stdout,
            install: INSTALL_HINT,
          },
        },
      );
    }
    const version = String(result.stdout ?? '').trim();
    _verifiedVersion = version;
    if (!isVersionAtLeast(version, MIN_AGENT365_VERSION)) {
      log.warn(
        { version, required: MIN_AGENT365_VERSION },
        'agent365 CLI version older than expected; behavior may differ',
      );
    }
    log.info({ version }, 'agent365 CLI detected');
    return version;
  } catch (err) {
    if (err instanceof PortalRequiredError) throw err;
    throw new PortalRequiredError(
      `agent365 CLI not on PATH. Install with: ${INSTALL_HINT}`,
      AGENT365_PORTAL_URL,
      { cause: err, details: { install: INSTALL_HINT } },
    );
  }
}

export function _resetAgent365VersionCache(): void {
  _verifiedVersion = undefined;
}

function isVersionAtLeast(actual: string, min: string): boolean {
  const a = parseVersion(actual);
  const m = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}

function parseVersion(s: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

// -----------------------------------------------------------------------------
// Arg builders — pure functions, easy to unit-test.
// -----------------------------------------------------------------------------

export interface Agent365BlueprintCreateOptions {
  name: string;
  projectPath: string;
  /**
   * When true, wire the Agent 365 grounding pipeline into the generated
   * blueprint (i.e. `--kb-sources agent-365`). Defaults to `false`.
   */
  kbSourcesAgent365?: boolean;
}

export function buildBlueprintCreateArgs(opts: Agent365BlueprintCreateOptions): string[] {
  const args = [
    'blueprint',
    'create',
    '--name',
    opts.name,
    '--path',
    opts.projectPath,
    '--non-interactive',
  ];
  if (opts.kbSourcesAgent365) {
    args.push('--kb-sources', 'agent-365');
  }
  return args;
}

export interface Agent365McpServerSpec {
  /** Logical name for the MCP server registration. */
  name: string;
  /** Remote URL or local command the MCP runtime should connect to. */
  url: string;
}

export interface Agent365McpAddOptions {
  projectPath: string;
  servers: readonly Agent365McpServerSpec[];
}

export function buildMcpAddArgs(server: Agent365McpServerSpec): string[] {
  return ['mcp', 'add', '--name', server.name, '--url', server.url, '--non-interactive'];
}

export interface Agent365PublishOptions {
  projectPath: string;
  env: string;
}

export function buildPublishArgs(opts: Agent365PublishOptions): string[] {
  return ['publish', '--env', opts.env, '--non-interactive'];
}

export interface Agent365CleanOptions {
  projectPath: string;
}

export function buildCleanArgs(_opts: Agent365CleanOptions): string[] {
  return ['clean', '--non-interactive'];
}

// -----------------------------------------------------------------------------
// Runners — drive `agent365` either via tmux (long jobs) or execa (short).
// -----------------------------------------------------------------------------

interface RunAgent365Options {
  name: string;
  args: string[];
  cwd: string;
  successRegex: RegExp;
  failureRegex?: RegExp;
  timeoutMs?: number;
  spawnFn?: Agent365SpawnFn;
}

async function runAgent365InTmux(opts: RunAgent365Options): Promise<string> {
  const spawnFn = opts.spawnFn ?? spawn;
  const failureRegex = opts.failureRegex ?? /(error|failed|✖|✗)\b/i;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;

  const argStr = opts.args.map(shellSingle).join(' ');
  const cmd = `bash -lc ${shellSingle(`${AGENT365_BIN} ${argStr} 2>&1; echo "[agent365-done:$?]"`)}`;
  log.info({ name: opts.name, args: opts.args, cwd: opts.cwd }, 'spawning agent365 worker');

  const handle = await spawnFn(cmd, { name: opts.name, cwd: opts.cwd });
  try {
    const buf = await handle.waitFor(/\[agent365-done:\d+\]/, { timeoutMs, pollMs: 2_000 });
    const exit = /\[agent365-done:(\d+)\]/.exec(buf);
    const exitCode = exit ? Number(exit[1]) : -1;
    if (exitCode !== 0) {
      throw new ProvisioningError(`agent365 ${opts.name} failed (exit ${exitCode})`, {
        details: { args: opts.args, tail: buf.slice(-2000) },
      });
    }
    if (failureRegex.test(buf) && !opts.successRegex.test(buf)) {
      throw new ProvisioningError(`agent365 ${opts.name} reported failure markers in output`, {
        details: { args: opts.args, tail: buf.slice(-2000) },
      });
    }
    log.info({ name: opts.name }, 'agent365 completed');
    return buf;
  } catch (err) {
    if (err instanceof ProvisioningError) throw err;
    throw new ProvisioningError(`agent365 ${opts.name} did not complete`, {
      cause: err,
      details: { args: opts.args },
    });
  }
}

interface RunAgent365ShortOptions {
  name: string;
  args: string[];
  cwd: string;
  exec?: Agent365Exec;
}

/**
 * Short, well-behaved commands (`mcp add`, `clean`) are driven directly via
 * execa — no tmux session required. Long-running scaffolds and publishes go
 * through {@link runAgent365InTmux} so we can stream output and time-out
 * gracefully.
 */
async function runAgent365Short(opts: RunAgent365ShortOptions): Promise<string> {
  const exec = opts.exec ?? (execa as unknown as Agent365Exec);
  log.info({ name: opts.name, args: opts.args, cwd: opts.cwd }, 'invoking agent365');
  const result = await exec(AGENT365_BIN, opts.args, { cwd: opts.cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new ProvisioningError(`agent365 ${opts.name} failed (exit ${result.exitCode})`, {
      details: {
        args: opts.args,
        stderr: String(result.stderr ?? '').slice(-2000),
        stdout: String(result.stdout ?? '').slice(-2000),
      },
    });
  }
  return String(result.stdout ?? '');
}

// -----------------------------------------------------------------------------
// Public wrapper functions.
// -----------------------------------------------------------------------------

export interface Agent365RunOptions {
  spawnFn?: Agent365SpawnFn;
  exec?: Agent365Exec;
}

export async function agent365BlueprintCreate(
  opts: Agent365BlueprintCreateOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion({ ...(runOpts.exec ? { exec: runOpts.exec } : {}) });
  if (!opts.name || opts.name.trim() === '') {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365BlueprintCreate requires a name');
  }
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365BlueprintCreate requires a projectPath');
  }
  await runAgent365InTmux({
    name: 'agent365-blueprint-create',
    args: buildBlueprintCreateArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(blueprint|scaffold(ed)?|created|completed|succeeded|✓)/i,
    ...(runOpts.spawnFn ? { spawnFn: runOpts.spawnFn } : {}),
  });
}

export async function agent365McpAdd(
  opts: Agent365McpAddOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion({ ...(runOpts.exec ? { exec: runOpts.exec } : {}) });
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365McpAdd requires a projectPath');
  }
  if (opts.servers.length === 0) {
    log.info('agent365McpAdd called with empty servers list; nothing to do');
    return;
  }
  for (const server of opts.servers) {
    if (!server.name || !server.url) {
      throw new AppFactoryError(
        'AGENT365_INPUT',
        `agent365McpAdd requires name and url for each server (got ${JSON.stringify(server)})`,
      );
    }
    await runAgent365Short({
      name: `agent365-mcp-add:${server.name}`,
      args: buildMcpAddArgs(server),
      cwd: opts.projectPath,
      ...(runOpts.exec ? { exec: runOpts.exec } : {}),
    });
  }
}

export async function agent365Publish(
  opts: Agent365PublishOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion({ ...(runOpts.exec ? { exec: runOpts.exec } : {}) });
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365Publish requires a projectPath');
  }
  await runAgent365InTmux({
    name: 'agent365-publish',
    args: buildPublishArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(publish(ed)?|deployed|completed|succeeded|✓)/i,
    ...(runOpts.spawnFn ? { spawnFn: runOpts.spawnFn } : {}),
  });
}

export async function agent365Clean(
  opts: Agent365CleanOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion({ ...(runOpts.exec ? { exec: runOpts.exec } : {}) });
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365Clean requires a projectPath');
  }
  await runAgent365Short({
    name: 'agent365-clean',
    args: buildCleanArgs(opts),
    cwd: opts.projectPath,
    ...(runOpts.exec ? { exec: runOpts.exec } : {}),
  });
}

function shellSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
