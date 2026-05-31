import { execa, type Options as ExecaOptions } from 'execa';
import { AppFactoryError } from '@app-factory/shared';
import {
  makeCliWrapper,
  spawn as orchestratorSpawn,
  type SpawnOptions,
  type WorkerHandle,
} from '@app-factory/orchestrator';

export const MIN_ATK_VERSION = '3.0.0';
const ATK_PORTAL_URL =
  'https://learn.microsoft.com/microsoftteams/platform/toolkit/teams-toolkit-cli';
const INSTALL_HINT = 'npm install -g @microsoft/m365agentstoolkit-cli';

export type AtkSpawnFn = (
  command: string,
  opts?: SpawnOptions,
) => Promise<WorkerHandle>;

const atkRunner = makeCliWrapper({
  bin: 'atk',
  name: 'm365 agents toolkit',
  minVersion: MIN_ATK_VERSION,
  installHint: INSTALL_HINT,
  portalUrl: ATK_PORTAL_URL,
  // Route spawn through the package surface so vi.mock('@app-factory/orchestrator')
  // in integration tests intercepts the call.
  spawnFn: orchestratorSpawn,
});

// ---------------------------------------------------------------------------
// Public version-detection surface (preserved for backwards compatibility).
// ---------------------------------------------------------------------------

export interface AssertAtkInstalledOptions {
  exec?: (file: string, args: string[], opts?: ExecaOptions) => ReturnType<typeof execa>;
}

export async function assertAtkInstalled(
  opts: AssertAtkInstalledOptions = {},
): Promise<string> {
  return atkRunner.detectVersion(opts);
}

export function _resetAtkVersionCache(): void {
  atkRunner.resetVersionCache();
}

// ---------------------------------------------------------------------------
// Arg builders — pure functions, unit-tested directly.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public wrappers — each one builds args + delegates to the shared runner.
// ---------------------------------------------------------------------------

interface AtkRunOpts {
  spawnFn?: AtkSpawnFn;
}

function tmuxOpts(
  name: string,
  args: string[],
  cwd: string,
  successRegex: RegExp,
  runOpts: AtkRunOpts,
) {
  const opts: Parameters<typeof atkRunner.runInTmux>[0] = {
    name,
    args,
    cwd,
    successRegex,
  };
  if (runOpts.spawnFn) opts.spawnFn = runOpts.spawnFn;
  return opts;
}

export async function atkNew(opts: AtkNewOptions, runOpts: AtkRunOpts = {}): Promise<void> {
  await assertAtkInstalled();
  await atkRunner.runInTmux(
    tmuxOpts(
      'atk-new',
      buildAtkNewArgs(opts),
      opts.folder,
      /(scaffolded|generated|created|completed|succeeded|✓)/i,
      runOpts,
    ),
  );
}

export async function atkProvision(
  opts: AtkProjectOptions,
  runOpts: AtkRunOpts = {},
): Promise<void> {
  await assertAtkInstalled();
  await atkRunner.runInTmux(
    tmuxOpts(
      'atk-provision',
      buildAtkProvisionArgs(opts),
      opts.projectPath,
      /provision(ing)?.*(succeeded|completed|✓)/i,
      runOpts,
    ),
  );
}

export async function atkDeploy(
  opts: AtkProjectOptions,
  runOpts: AtkRunOpts = {},
): Promise<void> {
  await assertAtkInstalled();
  await atkRunner.runInTmux(
    tmuxOpts(
      'atk-deploy',
      buildAtkDeployArgs(opts),
      opts.projectPath,
      /deploy(ment)?.*(succeeded|completed|✓)/i,
      runOpts,
    ),
  );
}

export async function atkPackage(
  opts: AtkPackageOptions,
  runOpts: AtkRunOpts = {},
): Promise<void> {
  await assertAtkInstalled();
  await atkRunner.runInTmux(
    tmuxOpts(
      'atk-package',
      buildAtkPackageArgs(opts),
      opts.projectPath,
      /package.*(succeeded|completed|built|✓)/i,
      runOpts,
    ),
  );
}

export async function atkValidate(
  opts: AtkValidateOptions,
  runOpts: AtkRunOpts = {},
): Promise<void> {
  await assertAtkInstalled();
  if (!opts.manifestPath && !opts.appPackagePath) {
    throw new AppFactoryError(
      'ATK_VALIDATE_INPUT',
      'atkValidate requires manifestPath or appPackagePath',
    );
  }
  await atkRunner.runInTmux(
    tmuxOpts(
      opts.manifestPath ? 'atk-validate-manifest' : 'atk-validate-package',
      buildAtkValidateArgs(opts),
      opts.projectPath,
      /(validation|validate).*(succeeded|completed|passed|✓)/i,
      runOpts,
    ),
  );
}

export async function atkUpdateTeamsApp(
  opts: AtkProjectOptions,
  runOpts: AtkRunOpts = {},
): Promise<void> {
  await assertAtkInstalled();
  await atkRunner.runInTmux(
    tmuxOpts(
      'atk-update-teams-app',
      buildAtkUpdateTeamsAppArgs(opts),
      opts.projectPath,
      /(updated|published|succeeded|completed|installed teams app|✓)/i,
      runOpts,
    ),
  );
}

export async function atkPreview(
  opts: AtkPreviewOptions,
  runOpts: AtkRunOpts = {},
): Promise<void> {
  await assertAtkInstalled();
  await atkRunner.runInTmux(
    tmuxOpts(
      'atk-preview',
      buildAtkPreviewArgs(opts),
      opts.projectPath,
      /(preview|listening|ready|started)/i,
      runOpts,
    ),
  );
}
