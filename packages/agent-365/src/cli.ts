import { execa, type Options as ExecaOptions } from 'execa';
import { AppFactoryError } from '@app-factory/shared';
import {
  makeCliWrapper,
  spawn as orchestratorSpawn,
  type SpawnOptions,
  type WorkerHandle,
} from '@app-factory/orchestrator';

export const MIN_AGENT365_VERSION = '0.1.0';
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

const agent365Runner = makeCliWrapper({
  bin: 'agent365',
  name: 'Microsoft Agent 365 CLI',
  minVersion: MIN_AGENT365_VERSION,
  installHint: INSTALL_HINT,
  portalUrl: AGENT365_PORTAL_URL,
  // Use the package-surface spawn so vi.mock('@app-factory/orchestrator')
  // intercepts the call from integration tests.
  spawnFn: orchestratorSpawn,
});

// ---------------------------------------------------------------------------
// Public version-detection surface.
// ---------------------------------------------------------------------------

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
  return agent365Runner.detectVersion(opts);
}

export function _resetAgent365VersionCache(): void {
  agent365Runner.resetVersionCache();
}

// ---------------------------------------------------------------------------
// Arg builders — pure functions, easy to unit-test.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public wrappers — each one builds args + delegates to the shared runner.
// ---------------------------------------------------------------------------

export interface Agent365RunOptions {
  spawnFn?: Agent365SpawnFn;
  exec?: Agent365Exec;
}

export async function agent365BlueprintCreate(
  opts: Agent365BlueprintCreateOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion(runOpts.exec ? { exec: runOpts.exec } : {});
  if (!opts.name || opts.name.trim() === '') {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365BlueprintCreate requires a name');
  }
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365BlueprintCreate requires a projectPath');
  }
  const runIn: Parameters<typeof agent365Runner.runInTmux>[0] = {
    name: 'agent365-blueprint-create',
    args: buildBlueprintCreateArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(blueprint|scaffold(ed)?|created|completed|succeeded|✓)/i,
  };
  if (runOpts.spawnFn) runIn.spawnFn = runOpts.spawnFn;
  await agent365Runner.runInTmux(runIn);
}

export async function agent365McpAdd(
  opts: Agent365McpAddOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion(runOpts.exec ? { exec: runOpts.exec } : {});
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365McpAdd requires a projectPath');
  }
  if (opts.servers.length === 0) return;
  for (const server of opts.servers) {
    if (!server.name || !server.url) {
      throw new AppFactoryError(
        'AGENT365_INPUT',
        `agent365McpAdd requires name and url for each server (got ${JSON.stringify(server)})`,
      );
    }
    const runShort: Parameters<typeof agent365Runner.run>[0] = {
      name: `agent365-mcp-add:${server.name}`,
      args: buildMcpAddArgs(server),
      cwd: opts.projectPath,
    };
    if (runOpts.exec) runShort.exec = runOpts.exec;
    await agent365Runner.run(runShort);
  }
}

export async function agent365Publish(
  opts: Agent365PublishOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion(runOpts.exec ? { exec: runOpts.exec } : {});
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365Publish requires a projectPath');
  }
  const runIn: Parameters<typeof agent365Runner.runInTmux>[0] = {
    name: 'agent365-publish',
    args: buildPublishArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(publish(ed)?|deployed|completed|succeeded|✓)/i,
  };
  if (runOpts.spawnFn) runIn.spawnFn = runOpts.spawnFn;
  await agent365Runner.runInTmux(runIn);
}

export async function agent365Clean(
  opts: Agent365CleanOptions,
  runOpts: Agent365RunOptions = {},
): Promise<void> {
  await detectAgent365CliVersion(runOpts.exec ? { exec: runOpts.exec } : {});
  if (!opts.projectPath) {
    throw new AppFactoryError('AGENT365_INPUT', 'agent365Clean requires a projectPath');
  }
  const runShort: Parameters<typeof agent365Runner.run>[0] = {
    name: 'agent365-clean',
    args: buildCleanArgs(opts),
    cwd: opts.projectPath,
  };
  if (runOpts.exec) runShort.exec = runOpts.exec;
  await agent365Runner.run(runShort);
}
