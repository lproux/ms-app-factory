import { execa, type ExecaError } from 'execa';
import { createLogger } from '@app-factory/shared';
import type { Recipe } from '@app-factory/elicitation';

const log = createLogger('cli:doctor');

/**
 * Status of a single probe.
 * - ok: required check passed.
 * - warn: optional/INFO check (e.g. an optional env var) — does not fail the run.
 * - fail: required check failed — `doctor` will exit 1 (or throw if invoked by `build`).
 */
export type ProbeStatus = 'ok' | 'warn' | 'fail';

export interface ProbeResult {
  /** Human-readable probe name (also used in the table). */
  readonly name: string;
  /** Outcome of the probe. */
  readonly status: ProbeStatus;
  /** Short detail line shown to the user (version string, env var value, error message). */
  readonly detail?: string;
  /** Suggested fix command when status === 'fail' or 'warn'. */
  readonly fixHint?: string;
  /** Whether this probe is required (a failure here trips exit 1). */
  readonly required: boolean;
}

/**
 * A single probe definition. The probe function returns `{ status, detail }` and we
 * stamp in the static `name`, `fixHint`, `required` fields.
 */
interface ProbeDef {
  readonly name: string;
  readonly required: boolean;
  readonly fixHint: string;
  readonly run: () => Promise<{ status: ProbeStatus; detail?: string }>;
}

/** Tool tags that recipes consume. */
export type ToolTag =
  | 'node'
  | 'pnpm'
  | 'tmux'
  | 'gh'
  | 'az'
  | 'pac'
  | 'atk'
  | 'agent365'
  | 'env:ANTHROPIC_API_KEY'
  | 'env:AZURE_TENANT_ID'
  | 'env:AZURE_SUBSCRIPTION_ID'
  | 'env:AZURE_CLIENT_ID'
  | 'env:AZURE_CLIENT_SECRET';

/** Base set every run needs. */
const BASE_TOOLS: readonly ToolTag[] = [
  'node',
  'pnpm',
  'tmux',
  'gh',
  'az',
  'env:ANTHROPIC_API_KEY',
  'env:AZURE_TENANT_ID',
  'env:AZURE_SUBSCRIPTION_ID',
  'env:AZURE_CLIENT_ID',
  'env:AZURE_CLIENT_SECRET',
];

/**
 * Determine the set of probes to run for a given recipe.
 *
 * - All recipes use the BASE_TOOLS set (node/pnpm/tmux/gh/az + env vars).
 * - `target: 'copilot-studio'` recipes additionally need `pac`.
 * - `target: 'teams'` recipes need `atk`.
 * - The `teams-agent-365` recipe additionally needs `agent365`.
 *
 * When `recipe` is undefined (e.g. `app-factory doctor` with no recipe selected),
 * every known tool is probed so the user sees the full matrix.
 */
export function selectToolsForRecipe(recipe?: Pick<Recipe, 'id' | 'target'>): ToolTag[] {
  const tools = new Set<ToolTag>(BASE_TOOLS);
  if (!recipe) {
    tools.add('pac');
    tools.add('atk');
    tools.add('agent365');
    return [...tools];
  }
  if (recipe.target === 'copilot-studio') tools.add('pac');
  if (recipe.target === 'teams') tools.add('atk');
  if (recipe.id === 'teams-agent-365') tools.add('agent365');
  return [...tools];
}

/* ----- individual probe implementations ----- */

async function probeBinary(
  bin: string,
  args: readonly string[],
): Promise<{ status: ProbeStatus; detail?: string }> {
  try {
    const r = await execa(bin, args, { reject: false });
    // execa@9 surfaces ENOENT as a result with `failed: true` rather than
    // throwing — check that explicitly so the user sees "not found on PATH"
    // instead of a confusing "exited undefined" message.
    const failed = (r as { failed?: boolean }).failed === true;
    const errCode = (r as { code?: string }).code;
    if (failed && (errCode === 'ENOENT' || r.exitCode === undefined)) {
      return { status: 'fail', detail: `${bin} not found on PATH` };
    }
    if (r.exitCode === 0) {
      const detail = (r.stdout || r.stderr || '').split('\n')[0]?.trim();
      return { status: 'ok', detail: detail || undefined };
    }
    return {
      status: 'fail',
      detail: `${bin} exited ${r.exitCode}: ${(r.stderr || r.stdout || '').slice(0, 200)}`,
    };
  } catch (err) {
    const e = err as ExecaError | NodeJS.ErrnoException;
    return { status: 'fail', detail: `${bin} not found on PATH (${(e as Error).message})` };
  }
}

async function probeNode(): Promise<{ status: ProbeStatus; detail?: string }> {
  const versionStr = process.versions.node;
  const major = Number.parseInt(versionStr.split('.')[0] ?? '0', 10);
  if (Number.isNaN(major)) {
    return { status: 'fail', detail: `unparseable node version: ${versionStr}` };
  }
  if (major < 22) {
    return { status: 'fail', detail: `node ${versionStr} (need >= 22)` };
  }
  return { status: 'ok', detail: `v${versionStr}` };
}

function probeEnv(
  name: string,
  required: boolean,
): { status: ProbeStatus; detail?: string } {
  const v = process.env[name];
  if (v && v.length > 0) {
    return { status: 'ok', detail: `set (${v.length} chars)` };
  }
  return {
    status: required ? 'fail' : 'warn',
    detail: required ? 'unset' : 'unset (optional)',
  };
}

/* ----- probe registry, keyed by ToolTag ----- */

function buildProbes(): Record<ToolTag, ProbeDef> {
  return {
    node: {
      name: 'node >= 22',
      required: true,
      fixHint: 'Install Node.js 22 LTS: https://nodejs.org/ or via fnm/nvm.',
      run: probeNode,
    },
    pnpm: {
      name: 'pnpm',
      required: true,
      fixHint: 'npm install -g pnpm@11.1.3',
      run: () => probeBinary('pnpm', ['--version']),
    },
    tmux: {
      name: 'tmux',
      required: true,
      fixHint: 'apt-get install -y tmux  (or `brew install tmux` on macOS).',
      run: () => probeBinary('tmux', ['-V']),
    },
    pac: {
      name: 'pac (Power Platform CLI)',
      required: true,
      fixHint: 'dotnet tool install --global Microsoft.PowerApps.CLI.Tool',
      run: () => probeBinary('pac', ['help']),
    },
    atk: {
      name: 'atk (M365 Agents Toolkit CLI)',
      required: true,
      fixHint: 'npm install -g @microsoft/m365agentstoolkit-cli',
      run: () => probeBinary('atk', ['-v']),
    },
    agent365: {
      name: 'agent365 CLI',
      required: true,
      fixHint: 'npm install -g @microsoft/agents-cli',
      run: () => probeBinary('agent365', ['-v']),
    },
    gh: {
      name: 'gh (GitHub CLI)',
      required: true,
      fixHint: 'https://cli.github.com/  (e.g. `brew install gh` or `winget install GitHub.cli`).',
      run: () => probeBinary('gh', ['--version']),
    },
    az: {
      name: 'az (Azure CLI)',
      required: true,
      fixHint: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
      run: () => probeBinary('az', ['--version']),
    },
    'env:ANTHROPIC_API_KEY': {
      name: 'env ANTHROPIC_API_KEY',
      required: true,
      fixHint: 'export ANTHROPIC_API_KEY=sk-ant-...   (used by the judge panel).',
      run: async () => probeEnv('ANTHROPIC_API_KEY', true),
    },
    'env:AZURE_TENANT_ID': {
      name: 'env AZURE_TENANT_ID',
      required: true,
      fixHint: 'export AZURE_TENANT_ID=<tenant-guid>',
      run: async () => probeEnv('AZURE_TENANT_ID', true),
    },
    'env:AZURE_SUBSCRIPTION_ID': {
      name: 'env AZURE_SUBSCRIPTION_ID',
      required: true,
      fixHint: 'export AZURE_SUBSCRIPTION_ID=<subscription-guid>',
      run: async () => probeEnv('AZURE_SUBSCRIPTION_ID', true),
    },
    'env:AZURE_CLIENT_ID': {
      name: 'env AZURE_CLIENT_ID',
      required: false,
      fixHint: 'optional — only needed for ServicePrincipal auth; DeviceCode works without.',
      run: async () => probeEnv('AZURE_CLIENT_ID', false),
    },
    'env:AZURE_CLIENT_SECRET': {
      name: 'env AZURE_CLIENT_SECRET',
      required: false,
      fixHint: 'optional — pairs with AZURE_CLIENT_ID for ServicePrincipal auth.',
      run: async () => probeEnv('AZURE_CLIENT_SECRET', false),
    },
  };
}

export interface DoctorOptions {
  /** Recipe to scope the probe set to. If omitted, probes the entire matrix. */
  readonly recipe?: Pick<Recipe, 'id' | 'target'>;
  /** Override the probe registry (used by tests to inject mocks/fakes). */
  readonly probes?: Record<ToolTag, ProbeDef>;
}

export interface DoctorReport {
  readonly recipe?: string;
  readonly results: readonly ProbeResult[];
  readonly ok: boolean;
}

/**
 * Run all probes for the (optionally) selected recipe and produce a report.
 */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const probes = options.probes ?? buildProbes();
  const tools = selectToolsForRecipe(options.recipe);
  log.debug({ tools, recipe: options.recipe?.id }, 'running doctor probes');

  const results: ProbeResult[] = [];
  for (const tag of tools) {
    const def = probes[tag];
    if (!def) {
      log.warn({ tag }, 'unknown probe tag — skipping');
      continue;
    }
    const { status, detail } = await def.run();
    results.push({
      name: def.name,
      status,
      detail,
      fixHint: status === 'ok' ? undefined : def.fixHint,
      required: def.required,
    });
  }

  const ok = results.every((r) => !(r.required && r.status === 'fail'));
  return { recipe: options.recipe?.id, results, ok };
}

/* ----- formatting ----- */

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
};

function statusBadge(s: ProbeStatus): string {
  if (s === 'ok') return `${ANSI.green}OK  ${ANSI.reset}`;
  if (s === 'warn') return `${ANSI.yellow}WARN${ANSI.reset}`;
  return `${ANSI.red}FAIL${ANSI.reset}`;
}

/**
 * Render the report as a pretty table to stdout. User-facing — `console.log` is intentional.
 */
export function printDoctorReport(report: DoctorReport): void {
  const header = report.recipe
    ? `App Factory doctor — recipe: ${report.recipe}`
    : 'App Factory doctor — full matrix';
  // eslint-disable-next-line no-console
  console.log(`\n${ANSI.bold}${header}${ANSI.reset}\n`);
  const nameWidth = Math.max(...report.results.map((r) => r.name.length), 10);
  for (const r of report.results) {
    const pad = r.name.padEnd(nameWidth, ' ');
    const detail = r.detail ? ` ${ANSI.dim}${r.detail}${ANSI.reset}` : '';
    // eslint-disable-next-line no-console
    console.log(`  ${statusBadge(r.status)}  ${pad}${detail}`);
    if (r.status !== 'ok' && r.fixHint) {
      // eslint-disable-next-line no-console
      console.log(`         ${ANSI.dim}fix: ${r.fixHint}${ANSI.reset}`);
    }
  }
  const failed = report.results.filter((r) => r.required && r.status === 'fail').length;
  const warned = report.results.filter((r) => r.status === 'warn').length;
  // eslint-disable-next-line no-console
  console.log(
    `\n  ${report.ok ? `${ANSI.green}all required checks passed${ANSI.reset}` : `${ANSI.red}${failed} required check(s) failed${ANSI.reset}`}` +
      (warned > 0 ? `, ${warned} warning(s)` : '') +
      '\n',
  );
}
