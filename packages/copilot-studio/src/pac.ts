import { execa, type Options as ExecaOptions } from 'execa';
import { createLogger, PortalRequiredError, ProvisioningError } from '@app-factory/shared';
import { spawn, type WorkerHandle } from '@app-factory/orchestrator';

const log = createLogger('copilot-studio:pac');

const PAC_BIN = process.env.PAC_BIN ?? 'pac';
const PAC_INSTALL_DOC = 'https://learn.microsoft.com/power-platform/developer/cli/introduction';
const PAC_INSTALL_CMD = 'dotnet tool install --global Microsoft.PowerApps.CLI.Tool';

export type PacAuthKind = 'ServicePrincipal' | 'DeviceCode' | 'CertificateFile' | 'WorkloadIdentity';
export type EnvType = 'Trial' | 'Sandbox' | 'Production' | 'Developer';

export interface PacAuthCreateOptions {
  kind: PacAuthKind;
  name?: string;
  tenant?: string;
  applicationId?: string;
  clientSecret?: string;
}

export interface PacEnvCreateOptions {
  name: string;
  region: string;
  type: EnvType;
  currency?: string;
  language?: string;
  domain?: string;
}

export interface PacEnv {
  id: string;
  displayName: string;
  url: string;
  region?: string;
  kind?: string;
}

export interface PacSolutionInitOptions {
  publisherName: string;
  publisherPrefix: string;
  outputDirectory: string;
}

export interface PacSolutionImportOptions {
  envId?: string;
  activatePlugins?: boolean;
  asyncWaitTimeMins?: number;
  /** When true, route the (long-running) import through tmux so the master orchestrator can watch it. */
  useTmux?: boolean;
  tmuxSession?: string;
  cwd?: string;
}

export interface PacSolutionExportOptions {
  uniqueName: string;
  managed?: boolean;
  envId?: string;
  cwd?: string;
}

export interface PacRunResult<T = unknown> {
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  parsed?: T;
}

export interface PacInvokeOptions extends Pick<ExecaOptions, 'cwd' | 'env'> {
  /** When true, parse stdout as JSON if a `--json` flag was supplied. */
  parseJson?: boolean;
}

let _pacChecked: boolean | undefined;

/** Verify `pac` is on PATH; throw a portal-required error pointing to the install command if not. */
export async function assertPacInstalled(): Promise<void> {
  if (_pacChecked) return;
  try {
    const r = await execa(PAC_BIN, ['help'], { reject: false });
    if (r.exitCode !== 0) {
      throw new PortalRequiredError(
        `Power Platform CLI ("pac") is not usable. Install it with: ${PAC_INSTALL_CMD}`,
        PAC_INSTALL_DOC,
        { details: { stderr: r.stderr, stdout: r.stdout } },
      );
    }
    _pacChecked = true;
  } catch (err) {
    if (err instanceof PortalRequiredError) throw err;
    throw new PortalRequiredError(
      `Power Platform CLI ("pac") is not installed. Install it with: ${PAC_INSTALL_CMD}`,
      PAC_INSTALL_DOC,
      { cause: err },
    );
  }
}

let _helpCache: string | undefined;
async function pacHelpText(): Promise<string> {
  if (_helpCache !== undefined) return _helpCache;
  const r = await execa(PAC_BIN, ['help'], { reject: false });
  _helpCache = `${r.stdout}\n${r.stderr}`;
  return _helpCache;
}

/** Heuristic feature detection by scanning `pac help` output. */
export async function pacSupports(token: string): Promise<boolean> {
  try {
    const text = await pacHelpText();
    return text.toLowerCase().includes(token.toLowerCase());
  } catch {
    return false;
  }
}

/** Low-level pac runner. Captures both streams; throws ProvisioningError on non-zero. */
export async function runPac<T = unknown>(
  argv: string[],
  opts: PacInvokeOptions = {},
): Promise<PacRunResult<T>> {
  await assertPacInstalled();
  log.debug({ argv }, 'pac invoke');
  const r = await execa(PAC_BIN, argv, {
    reject: false,
    cwd: opts.cwd,
    env: opts.env,
  });
  const result: PacRunResult<T> = {
    argv,
    exitCode: r.exitCode ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
  if ((r.exitCode ?? -1) !== 0) {
    throw new ProvisioningError(`pac ${argv.join(' ')} exited ${r.exitCode}`, {
      details: { stdout: result.stdout, stderr: result.stderr, argv },
    });
  }
  if (opts.parseJson && argv.includes('--json')) {
    try {
      result.parsed = JSON.parse(result.stdout) as T;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'pac --json output not parseable; falling back to text');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// pac auth
// ---------------------------------------------------------------------------

export function buildAuthCreateArgs(opts: PacAuthCreateOptions): string[] {
  const argv = ['auth', 'create', '--kind', opts.kind];
  if (opts.name) argv.push('--name', opts.name);
  if (opts.tenant) argv.push('--tenant', opts.tenant);
  if (opts.kind === 'ServicePrincipal') {
    if (!opts.applicationId || !opts.clientSecret) {
      throw new ProvisioningError('ServicePrincipal auth requires applicationId and clientSecret');
    }
    argv.push('--applicationId', opts.applicationId, '--clientSecret', opts.clientSecret);
  }
  return argv;
}

export async function authCreate(opts: PacAuthCreateOptions): Promise<PacRunResult> {
  return runPac(buildAuthCreateArgs(opts));
}

export async function authSelect(index: number): Promise<PacRunResult> {
  return runPac(['auth', 'select', '--index', String(index)]);
}

export interface PacAuthProfile {
  index: number;
  name?: string;
  kind?: string;
  user?: string;
  cloud?: string;
  isActive?: boolean;
}

export async function authList(): Promise<PacAuthProfile[]> {
  const r = await runPac<PacAuthProfile[] | { items: PacAuthProfile[] }>(['auth', 'list', '--json'], {
    parseJson: true,
  });
  if (!r.parsed) {
    log.warn('pac auth list returned no JSON; falling back to text scrape');
    return parseAuthListText(r.stdout);
  }
  if (Array.isArray(r.parsed)) return r.parsed;
  if (r.parsed && Array.isArray((r.parsed as { items?: PacAuthProfile[] }).items)) {
    return (r.parsed as { items: PacAuthProfile[] }).items;
  }
  return [];
}

function parseAuthListText(text: string): PacAuthProfile[] {
  const profiles: PacAuthProfile[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[?(\d+)\]?\s+(\*?)\s*([^\s]+)?\s+(.*)$/.exec(line);
    if (!m) continue;
    const idx = Number.parseInt(m[1] ?? '', 10);
    if (Number.isNaN(idx)) continue;
    profiles.push({
      index: idx,
      isActive: (m[2] ?? '').includes('*'),
      kind: m[3],
      name: m[4]?.trim(),
    });
  }
  return profiles;
}

// ---------------------------------------------------------------------------
// pac env
// ---------------------------------------------------------------------------

export function buildEnvListArgs(): string[] {
  return ['env', 'list', '--json'];
}

export async function envList(): Promise<PacEnv[]> {
  const r = await runPac<PacEnv[] | { items: PacEnv[] }>(buildEnvListArgs(), { parseJson: true });
  if (!r.parsed) {
    log.warn('pac env list returned no JSON; falling back to text scrape');
    return parseEnvListText(r.stdout);
  }
  if (Array.isArray(r.parsed)) return r.parsed;
  if (r.parsed && Array.isArray((r.parsed as { items?: PacEnv[] }).items)) {
    return (r.parsed as { items: PacEnv[] }).items;
  }
  return [];
}

function parseEnvListText(text: string): PacEnv[] {
  const envs: PacEnv[] = [];
  const rx = /([0-9a-fA-F-]{36})\s+(\S+)\s+(https?:\/\/\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(text))) {
    envs.push({ id: m[1] ?? '', displayName: m[2] ?? '', url: m[3] ?? '' });
  }
  return envs;
}

export function buildEnvCreateArgs(opts: PacEnvCreateOptions): string[] {
  const argv = ['env', 'create', '--name', opts.name, '--region', opts.region, '--type', opts.type];
  if (opts.currency) argv.push('--currency', opts.currency);
  if (opts.language) argv.push('--language', opts.language);
  if (opts.domain) argv.push('--domain', opts.domain);
  return argv;
}

export async function envCreate(opts: PacEnvCreateOptions): Promise<PacEnv> {
  const r = await runPac(buildEnvCreateArgs(opts));
  const id = /([0-9a-fA-F-]{36})/.exec(r.stdout)?.[1] ?? '';
  const url = /https?:\/\/\S+/.exec(r.stdout)?.[0] ?? '';
  return { id, displayName: opts.name, url, region: opts.region, kind: opts.type };
}

export async function envSelect(envId: string): Promise<PacRunResult> {
  return runPac(['env', 'select', '--environment', envId]);
}

// ---------------------------------------------------------------------------
// pac solution
// ---------------------------------------------------------------------------

export function buildSolutionInitArgs(opts: PacSolutionInitOptions): string[] {
  return [
    'solution',
    'init',
    '--publisher-name',
    opts.publisherName,
    '--publisher-prefix',
    opts.publisherPrefix,
    '--outputDirectory',
    opts.outputDirectory,
  ];
}

export async function solutionInit(opts: PacSolutionInitOptions): Promise<PacRunResult> {
  return runPac(buildSolutionInitArgs(opts));
}

export function buildSolutionAddReferenceArgs(refPath: string): string[] {
  return ['solution', 'add-reference', '--path', refPath];
}

export async function solutionAddReference(refPath: string, cwd?: string): Promise<PacRunResult> {
  return runPac(buildSolutionAddReferenceArgs(refPath), { cwd });
}

export function buildSolutionImportArgs(zip: string, opts: PacSolutionImportOptions = {}): string[] {
  const argv = ['solution', 'import', '--path', zip];
  if (opts.activatePlugins ?? true) argv.push('--activate-plugins');
  if (opts.asyncWaitTimeMins !== undefined) {
    argv.push('--async-wait-time', String(opts.asyncWaitTimeMins));
  }
  if (opts.envId) argv.push('--environment', opts.envId);
  return argv;
}

export interface SolutionImportResult {
  ok: boolean;
  solutionId?: string;
  stdout: string;
  stderr: string;
}

export async function solutionImport(
  zip: string,
  opts: PacSolutionImportOptions = {},
): Promise<SolutionImportResult> {
  const argv = buildSolutionImportArgs(zip, opts);
  if (opts.useTmux ?? true) {
    return tmuxSolutionImport(argv, opts);
  }
  const r = await runPac(argv, { cwd: opts.cwd });
  return {
    ok: r.exitCode === 0,
    solutionId: extractSolutionId(r.stdout),
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

async function tmuxSolutionImport(
  argv: string[],
  opts: PacSolutionImportOptions,
): Promise<SolutionImportResult> {
  await assertPacInstalled();
  const cmd = [PAC_BIN, ...argv.map((a) => (a.includes(' ') ? `'${a}'` : a))].join(' ');
  let handle: WorkerHandle | undefined;
  try {
    handle = await spawn(`${cmd}; echo PAC_DONE=$?`, {
      name: `pac-import-${Date.now()}`,
      session: opts.tmuxSession ?? 'app-factory',
      cwd: opts.cwd,
    });
    const buf = await handle.waitFor(/PAC_DONE=(\d+)/, {
      timeoutMs: Math.max(60_000, (opts.asyncWaitTimeMins ?? 30) * 60_000 + 30_000),
      pollMs: 2_000,
    });
    const code = Number.parseInt(/PAC_DONE=(\d+)/.exec(buf)?.[1] ?? '-1', 10);
    if (code !== 0) {
      throw new ProvisioningError(`pac solution import (tmux) exited ${code}`, {
        details: { tail: buf.split(/\r?\n/).slice(-40).join('\n') },
      });
    }
    return {
      ok: true,
      solutionId: extractSolutionId(buf),
      stdout: buf,
      stderr: '',
    };
  } finally {
    if (handle) await handle.kill().catch(() => undefined);
  }
}

function extractSolutionId(text: string): string | undefined {
  const m = /Solution\s+(?:Id|ID)[^0-9a-fA-F]*([0-9a-fA-F-]{36})/.exec(text);
  return m?.[1];
}

export function buildSolutionExportArgs(zip: string, opts: PacSolutionExportOptions): string[] {
  const argv = ['solution', 'export', '--path', zip, '--name', opts.uniqueName];
  if (opts.managed) argv.push('--managed');
  if (opts.envId) argv.push('--environment', opts.envId);
  return argv;
}

export async function solutionExport(
  zip: string,
  opts: PacSolutionExportOptions,
): Promise<PacRunResult> {
  return runPac(buildSolutionExportArgs(zip, opts), { cwd: opts.cwd });
}

export async function solutionPublish(envId?: string): Promise<PacRunResult> {
  const argv = ['solution', 'publish'];
  if (envId) argv.push('--environment', envId);
  return runPac(argv);
}

export async function copilotPublish(envId?: string): Promise<PacRunResult | null> {
  if (!(await pacSupports('copilot'))) {
    log.warn('pac copilot subcommand not detected; skipping');
    return null;
  }
  const argv = ['copilot', 'publish'];
  if (envId) argv.push('--environment', envId);
  return runPac(argv);
}

// ---------------------------------------------------------------------------
// pac connector
// ---------------------------------------------------------------------------

export interface ConnectorCreateOptions {
  apiDefinitionFile: string;
  envId?: string;
  apiPropertiesFile?: string;
  iconFile?: string;
}

export function buildConnectorCreateArgs(opts: ConnectorCreateOptions): string[] {
  const argv = ['connector', 'create', '--api-definition-file', opts.apiDefinitionFile];
  if (opts.apiPropertiesFile) argv.push('--api-properties-file', opts.apiPropertiesFile);
  if (opts.iconFile) argv.push('--icon-file', opts.iconFile);
  if (opts.envId) argv.push('--environment', opts.envId);
  return argv;
}

export async function connectorCreate(opts: ConnectorCreateOptions): Promise<PacRunResult> {
  return runPac(buildConnectorCreateArgs(opts));
}

/** Convenience accessor — the public façade used by the WBS index orchestrator. */
export const pac = {
  assertPacInstalled,
  runPac,
  authCreate,
  authSelect,
  authList,
  envList,
  envCreate,
  envSelect,
  solutionInit,
  solutionAddReference,
  solutionImport,
  solutionExport,
  solutionPublish,
  copilotPublish,
  connectorCreate,
};

export type PacWrapper = typeof pac;
