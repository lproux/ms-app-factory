import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock execa so binary probes don't shell out to the real $PATH. We control
// the exitCode/stdout per case to drive ok/fail branches.
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { runDoctor, selectToolsForRecipe, type ToolTag } from '../src/doctor.js';

const execaMock = execa as unknown as ReturnType<typeof vi.fn>;

/** Make every probed binary succeed. */
function mockAllBinariesOk() {
  execaMock.mockImplementation(async (bin: string) => ({
    exitCode: 0,
    stdout: `${bin} 1.2.3`,
    stderr: '',
  }));
}

/** Make every probed binary fail (ENOENT). */
function mockAllBinariesMissing() {
  execaMock.mockImplementation(async () => {
    throw new Error('spawn ENOENT');
  });
}

/** Save and restore env vars touched by env probes. */
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'AZURE_TENANT_ID',
  'AZURE_SUBSCRIPTION_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
] as const;

let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  execaMock.mockReset();
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('selectToolsForRecipe — recipe-aware probe selection', () => {
  it('teams-bot-basic asks for atk but NOT pac', () => {
    const tools = selectToolsForRecipe({ id: 'teams-bot-basic', target: 'teams' });
    expect(tools).toContain<ToolTag>('atk');
    expect(tools).not.toContain<ToolTag>('pac');
    expect(tools).not.toContain<ToolTag>('agent365');
  });

  it('copilot-studio-support-bot asks for pac but NOT atk', () => {
    const tools = selectToolsForRecipe({
      id: 'copilot-studio-support-bot',
      target: 'copilot-studio',
    });
    expect(tools).toContain<ToolTag>('pac');
    expect(tools).not.toContain<ToolTag>('atk');
    expect(tools).not.toContain<ToolTag>('agent365');
  });

  it('teams-agent-365 asks for atk AND agent365', () => {
    const tools = selectToolsForRecipe({ id: 'teams-agent-365', target: 'teams' });
    expect(tools).toContain<ToolTag>('atk');
    expect(tools).toContain<ToolTag>('agent365');
  });

  it('no recipe → full matrix (probe everything)', () => {
    const tools = selectToolsForRecipe(undefined);
    expect(tools).toContain<ToolTag>('pac');
    expect(tools).toContain<ToolTag>('atk');
    expect(tools).toContain<ToolTag>('agent365');
  });

  it('every recipe-scoped run includes the base toolchain (node/pnpm/tmux/gh/az + required env vars)', () => {
    const tools = selectToolsForRecipe({ id: 'teams-bot-basic', target: 'teams' });
    for (const required of [
      'node',
      'pnpm',
      'tmux',
      'gh',
      'az',
      'env:ANTHROPIC_API_KEY',
      'env:AZURE_TENANT_ID',
      'env:AZURE_SUBSCRIPTION_ID',
    ] as const) {
      expect(tools).toContain<ToolTag>(required);
    }
  });
});

describe('runDoctor — happy path', () => {
  it('returns ok=true when all binaries and required env vars are present', async () => {
    mockAllBinariesOk();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000000';
    process.env.AZURE_SUBSCRIPTION_ID = '11111111-1111-1111-1111-111111111111';
    const report = await runDoctor({ recipe: { id: 'teams-bot-basic', target: 'teams' } });
    expect(report.ok).toBe(true);
    expect(report.results.every((r) => r.status !== 'fail' || !r.required)).toBe(true);
    // optional env vars unset → warn, not fail
    const clientId = report.results.find((r) => r.name === 'env AZURE_CLIENT_ID');
    expect(clientId?.status).toBe('warn');
    expect(clientId?.required).toBe(false);
  });
});

describe('runDoctor — failure paths', () => {
  it('flags missing binaries as fail and attaches the documented fix hint', async () => {
    mockAllBinariesMissing();
    // Leave all env vars unset.
    const report = await runDoctor({
      recipe: { id: 'copilot-studio-support-bot', target: 'copilot-studio' },
    });
    expect(report.ok).toBe(false);
    const pac = report.results.find((r) => r.name.startsWith('pac'));
    expect(pac).toBeDefined();
    expect(pac?.status).toBe('fail');
    expect(pac?.fixHint).toMatch(/dotnet tool install --global Microsoft\.PowerApps\.CLI\.Tool/);

    const anthropic = report.results.find((r) => r.name === 'env ANTHROPIC_API_KEY');
    expect(anthropic?.status).toBe('fail');
    expect(anthropic?.fixHint).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('a single missing required check is enough to flip ok=false', async () => {
    // All binaries OK, but ANTHROPIC_API_KEY (required) is unset.
    mockAllBinariesOk();
    process.env.AZURE_TENANT_ID = 't';
    process.env.AZURE_SUBSCRIPTION_ID = 's';
    const report = await runDoctor({
      recipe: { id: 'teams-bot-basic', target: 'teams' },
    });
    expect(report.ok).toBe(false);
    const failed = report.results.filter((r) => r.required && r.status === 'fail');
    expect(failed.map((f) => f.name)).toContain('env ANTHROPIC_API_KEY');
  });

  it('optional env vars (AZURE_CLIENT_ID/SECRET) being unset do NOT trip ok=false', async () => {
    mockAllBinariesOk();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AZURE_TENANT_ID = 't';
    process.env.AZURE_SUBSCRIPTION_ID = 's';
    // AZURE_CLIENT_ID/SECRET intentionally unset.
    const report = await runDoctor({
      recipe: { id: 'teams-bot-basic', target: 'teams' },
    });
    expect(report.ok).toBe(true);
    const warns = report.results.filter((r) => r.status === 'warn').map((r) => r.name);
    expect(warns).toContain('env AZURE_CLIENT_ID');
    expect(warns).toContain('env AZURE_CLIENT_SECRET');
  });
});

describe('runDoctor — recipe scoping skips irrelevant probes', () => {
  it('teams-bot-basic does NOT probe pac', async () => {
    mockAllBinariesOk();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AZURE_TENANT_ID = 't';
    process.env.AZURE_SUBSCRIPTION_ID = 's';
    const report = await runDoctor({ recipe: { id: 'teams-bot-basic', target: 'teams' } });
    expect(report.results.find((r) => r.name.startsWith('pac'))).toBeUndefined();
    // It DOES probe atk.
    expect(report.results.find((r) => r.name.startsWith('atk'))).toBeDefined();
    // The execa mock should never have been called with 'pac'.
    const pacCalls = execaMock.mock.calls.filter((c) => c[0] === 'pac');
    expect(pacCalls).toHaveLength(0);
  });

  it('copilot-studio-support-bot does NOT probe atk or agent365', async () => {
    mockAllBinariesOk();
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AZURE_TENANT_ID = 't';
    process.env.AZURE_SUBSCRIPTION_ID = 's';
    const report = await runDoctor({
      recipe: { id: 'copilot-studio-support-bot', target: 'copilot-studio' },
    });
    expect(report.results.find((r) => r.name.startsWith('atk'))).toBeUndefined();
    expect(report.results.find((r) => r.name.startsWith('agent365'))).toBeUndefined();
    expect(report.results.find((r) => r.name.startsWith('pac'))).toBeDefined();
    const atkCalls = execaMock.mock.calls.filter((c) => c[0] === 'atk');
    const agent365Calls = execaMock.mock.calls.filter((c) => c[0] === 'agent365');
    expect(atkCalls).toHaveLength(0);
    expect(agent365Calls).toHaveLength(0);
  });
});
