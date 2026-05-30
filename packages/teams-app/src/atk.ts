import { execa, type Options as ExecaOptions } from 'execa';
import {
  AppFactoryError,
  PortalRequiredError,
  ProvisioningError,
  createLogger,
} from '@app-factory/shared';
import { spawn, type SpawnOptions, type WorkerHandle } from '@app-factory/orchestrator';

const log = createLogger('teams-app:atk');

export const MIN_ATK_VERSION = '3.0.0';
const ATK_BIN = 'atk';
const ATK_PORTAL_URL = 'https://learn.microsoft.com/microsoftteams/platform/toolkit/teams-toolkit-cli';
const INSTALL_HINT = 'npm install -g @microsoft/m365agentstoolkit-cli';

export type AtkSpawnFn = (command: string, opts?: SpawnOptions) => Promise<WorkerHandle>;

let _verifiedVersion: string | undefined;

export interface AssertAtkInstalledOptions {
  exec?: (file: string, args: string[], opts?: ExecaOptions) => ReturnType<typeof execa>;
}

export async function assertAtkInstalled(opts: AssertAtkInstalledOptions = {}): Promise<string> {
  if (_verifiedVersion) return _verifiedVersion;
  const exec = opts.exec ?? (execa as unknown as (file: string, args: string[], opts?: ExecaOptions) => ReturnType<typeof execa>);
  try {
    const result = await exec(ATK_BIN, ['--version'], { reject: false });
    if (result.exitCode !== 0) {
      throw new PortalRequiredError(
        `atk CLI not available (exit ${result.exitCode}). Install with: ${INSTALL_HINT}`,
        ATK_PORTAL_URL,
        { details: { stderr: result.stderr, stdout: result.stdout, install: INSTALL_HINT } },
      );
    }
    const version = String(result.stdout ?? '').trim();
    _verifiedVersion = version;
    if (!isVersionAtLeast(version, MIN_ATK_VERSION)) {
      log.warn(
        { version, required: MIN_ATK_VERSION },
        'atk CLI version is older than expected; behavior may differ',
      );
    }
    log.info({ version }, 'atk CLI detected');
    return version;
  } catch (err) {
    if (err instanceof PortalRequiredError) throw err;
    throw new PortalRequiredError(
      `atk CLI not on PATH. Install with: ${INSTALL_HINT}`,
      ATK_PORTAL_URL,
      { cause: err, details: { install: INSTALL_HINT } },
    );
  }
}

export function _resetAtkVersionCache(): void {
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

export interface AtkNewOptions {
  template: string;
  name: string;
  folder: string;
  capability?: string;
}

export function buildAtkNewArgs(opts: AtkNewOptions): string[] {
  const args = [
    'new',
    '--template',
    opts.template,
    '--app-name',
    opts.name,
    '--folder',
    opts.folder,
    '--interactive',
    'false',
  ];
  if (opts.capability) {
    args.push('--capability', opts.capability);
  }
  return args;
}

export interface AtkProjectOptions {
  env: string;
  projectPath: string;
}

export function buildAtkProvisionArgs(opts: AtkProjectOptions): string[] {
  return ['provision', '--env', opts.env, '--interactive', 'false'];
}

export function buildAtkDeployArgs(opts: AtkProjectOptions): string[] {
  return ['deploy', '--env', opts.env, '--interactive', 'false'];
}

export interface AtkPackageOptions extends AtkProjectOptions {
  outDir: string;
}

export function buildAtkPackageArgs(opts: AtkPackageOptions): string[] {
  return [
    'package',
    '--env',
    opts.env,
    '--output-folder',
    opts.outDir,
    '--interactive',
    'false',
  ];
}

export interface AtkValidateOptions {
  manifestPath?: string;
  appPackagePath?: string;
  projectPath: string;
  env?: string;
}

export function buildAtkValidateArgs(opts: AtkValidateOptions): string[] {
  const args = ['validate', '--interactive', 'false'];
  if (opts.env) args.push('--env', opts.env);
  if (opts.manifestPath) args.push('--manifest-path', opts.manifestPath);
  if (opts.appPackagePath) args.push('--app-package-file-path', opts.appPackagePath);
  return args;
}

export function buildAtkUpdateTeamsAppArgs(opts: AtkProjectOptions): string[] {
  return ['update', 'teams-app', '--env', opts.env, '--interactive', 'false'];
}

export interface AtkPreviewOptions extends AtkProjectOptions {
  openBrowser?: boolean;
}

export function buildAtkPreviewArgs(opts: AtkPreviewOptions): string[] {
  const args = ['preview', '--env', opts.env, '--interactive', 'false'];
  if (opts.openBrowser === false) args.push('--no-browser');
  return args;
}

interface RunAtkOptions {
  name: string;
  args: string[];
  cwd: string;
  successRegex: RegExp;
  failureRegex?: RegExp;
  timeoutMs?: number;
  spawnFn?: AtkSpawnFn;
}

async function runAtkInTmux(opts: RunAtkOptions): Promise<string> {
  const spawnFn = opts.spawnFn ?? spawn;
  const failureRegex =
    opts.failureRegex ?? /(error|failed|✖|✗)\b/i;
  const timeoutMs = opts.timeoutMs ?? 20 * 60_000;

  const argStr = opts.args.map(shellSingle).join(' ');
  const cmd = `bash -lc ${shellSingle(`${ATK_BIN} ${argStr} 2>&1; echo "[atk-done:$?]"`)}`;
  log.info({ name: opts.name, args: opts.args, cwd: opts.cwd }, 'spawning atk worker');

  const handle = await spawnFn(cmd, { name: opts.name, cwd: opts.cwd });
  try {
    const buf = await handle.waitFor(/\[atk-done:\d+\]/, { timeoutMs, pollMs: 2_000 });
    const exit = /\[atk-done:(\d+)\]/.exec(buf);
    const exitCode = exit ? Number(exit[1]) : -1;
    if (exitCode !== 0) {
      throw new ProvisioningError(`atk ${opts.name} failed (exit ${exitCode})`, {
        details: { args: opts.args, tail: buf.slice(-2000) },
      });
    }
    if (failureRegex.test(buf) && !opts.successRegex.test(buf)) {
      throw new ProvisioningError(`atk ${opts.name} reported failure markers in output`, {
        details: { args: opts.args, tail: buf.slice(-2000) },
      });
    }
    log.info({ name: opts.name }, 'atk completed');
    return buf;
  } catch (err) {
    if (err instanceof ProvisioningError) throw err;
    throw new ProvisioningError(`atk ${opts.name} did not complete`, {
      cause: err,
      details: { args: opts.args },
    });
  }
}

const SUCCESS_REGEX = /(succeeded|completed|✓|installed teams app|published)/i;

export async function atkNew(opts: AtkNewOptions, runOpts: { spawnFn?: AtkSpawnFn } = {}): Promise<void> {
  await assertAtkInstalled();
  await runAtkInTmux({
    name: 'atk-new',
    args: buildAtkNewArgs(opts),
    cwd: opts.folder,
    successRegex: /(scaffolded|generated|created|completed|succeeded|✓)/i,
    spawnFn: runOpts.spawnFn,
  });
}

export async function atkProvision(
  opts: AtkProjectOptions,
  runOpts: { spawnFn?: AtkSpawnFn } = {},
): Promise<void> {
  await assertAtkInstalled();
  await runAtkInTmux({
    name: 'atk-provision',
    args: buildAtkProvisionArgs(opts),
    cwd: opts.projectPath,
    successRegex: /provision(ing)?.*(succeeded|completed|✓)/i,
    spawnFn: runOpts.spawnFn,
  });
}

export async function atkDeploy(
  opts: AtkProjectOptions,
  runOpts: { spawnFn?: AtkSpawnFn } = {},
): Promise<void> {
  await assertAtkInstalled();
  await runAtkInTmux({
    name: 'atk-deploy',
    args: buildAtkDeployArgs(opts),
    cwd: opts.projectPath,
    successRegex: /deploy(ment)?.*(succeeded|completed|✓)/i,
    spawnFn: runOpts.spawnFn,
  });
}

export async function atkPackage(
  opts: AtkPackageOptions,
  runOpts: { spawnFn?: AtkSpawnFn } = {},
): Promise<void> {
  await assertAtkInstalled();
  await runAtkInTmux({
    name: 'atk-package',
    args: buildAtkPackageArgs(opts),
    cwd: opts.projectPath,
    successRegex: /package.*(succeeded|completed|built|✓)/i,
    spawnFn: runOpts.spawnFn,
  });
}

export async function atkValidate(
  opts: AtkValidateOptions,
  runOpts: { spawnFn?: AtkSpawnFn } = {},
): Promise<void> {
  await assertAtkInstalled();
  if (!opts.manifestPath && !opts.appPackagePath) {
    throw new AppFactoryError(
      'ATK_VALIDATE_INPUT',
      'atkValidate requires manifestPath or appPackagePath',
    );
  }
  await runAtkInTmux({
    name: opts.manifestPath ? 'atk-validate-manifest' : 'atk-validate-package',
    args: buildAtkValidateArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(validation|validate).*(succeeded|completed|passed|✓)/i,
    spawnFn: runOpts.spawnFn,
  });
}

export async function atkUpdateTeamsApp(
  opts: AtkProjectOptions,
  runOpts: { spawnFn?: AtkSpawnFn } = {},
): Promise<void> {
  await assertAtkInstalled();
  await runAtkInTmux({
    name: 'atk-update-teams-app',
    args: buildAtkUpdateTeamsAppArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(updated|published|succeeded|completed|installed teams app|✓)/i,
    spawnFn: runOpts.spawnFn,
  });
}

export async function atkPreview(
  opts: AtkPreviewOptions,
  runOpts: { spawnFn?: AtkSpawnFn } = {},
): Promise<void> {
  await assertAtkInstalled();
  await runAtkInTmux({
    name: 'atk-preview',
    args: buildAtkPreviewArgs(opts),
    cwd: opts.projectPath,
    successRegex: /(preview|listening|ready|started)/i,
    spawnFn: runOpts.spawnFn,
  });
}

function shellSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
