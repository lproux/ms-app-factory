import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkerHandle } from '@app-factory/orchestrator';
import {
  buildBlueprintCreateArgs,
  buildMcpAddArgs,
  buildPublishArgs,
  buildCleanArgs,
  detectAgent365CliVersion,
  _resetAgent365VersionCache,
  agent365BlueprintCreate,
  agent365McpAdd,
  agent365Publish,
  agent365Clean,
  MIN_AGENT365_VERSION,
} from '../src/cli.js';

beforeEach(() => {
  _resetAgent365VersionCache();
});

function fakeWorker(buf: string): WorkerHandle {
  return {
    id: 'w',
    session: 's',
    window: 'win',
    command: 'cmd',
    async send() {
      /* noop */
    },
    async capture() {
      return buf;
    },
    async waitFor() {
      return buf;
    },
    async kill() {
      /* noop */
    },
  };
}

describe('agent365 arg builders', () => {
  it('buildBlueprintCreateArgs emits name + path + non-interactive', () => {
    expect(buildBlueprintCreateArgs({ name: 'myagent', projectPath: '/work/myagent' })).toEqual([
      'blueprint',
      'create',
      '--name',
      'myagent',
      '--path',
      '/work/myagent',
      '--non-interactive',
    ]);
  });

  it('buildBlueprintCreateArgs appends --kb-sources agent-365 when requested', () => {
    const args = buildBlueprintCreateArgs({
      name: 'a',
      projectPath: '/p',
      kbSourcesAgent365: true,
    });
    expect(args).toContain('--kb-sources');
    expect(args).toContain('agent-365');
  });

  it('buildMcpAddArgs targets one server registration', () => {
    expect(
      buildMcpAddArgs({ name: 'docs', url: 'https://mcp.example.com/docs' }),
    ).toEqual([
      'mcp',
      'add',
      '--name',
      'docs',
      '--url',
      'https://mcp.example.com/docs',
      '--non-interactive',
    ]);
  });

  it('buildPublishArgs includes the env flag', () => {
    expect(buildPublishArgs({ env: 'dev', projectPath: '/p' })).toEqual([
      'publish',
      '--env',
      'dev',
      '--non-interactive',
    ]);
  });

  it('buildCleanArgs emits clean with non-interactive', () => {
    expect(buildCleanArgs({ projectPath: '/p' })).toEqual(['clean', '--non-interactive']);
  });
});

describe('detectAgent365CliVersion', () => {
  it('throws PortalRequiredError with the install hint when --version fails', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'command not found',
    })) as unknown as Parameters<typeof detectAgent365CliVersion>[0]['exec'];
    await expect(detectAgent365CliVersion({ exec })).rejects.toMatchObject({
      code: 'PORTAL_REQUIRED',
      portalUrl: expect.stringContaining('agent-365'),
      message: expect.stringContaining('npm i -g @microsoft/agent-365-cli'),
    });
  });

  it('throws PortalRequiredError when exec itself throws', async () => {
    const exec = vi.fn(async () => {
      throw new Error('ENOENT');
    }) as unknown as Parameters<typeof detectAgent365CliVersion>[0]['exec'];
    await expect(detectAgent365CliVersion({ exec })).rejects.toMatchObject({
      code: 'PORTAL_REQUIRED',
    });
  });

  it('returns the version string on success', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '0.2.1',
      stderr: '',
    })) as unknown as Parameters<typeof detectAgent365CliVersion>[0]['exec'];
    const v = await detectAgent365CliVersion({ exec });
    expect(v).toBe('0.2.1');
  });

  it('still resolves when version is older than MIN (warns only)', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '0.0.9',
      stderr: '',
    })) as unknown as Parameters<typeof detectAgent365CliVersion>[0]['exec'];
    const v = await detectAgent365CliVersion({ exec });
    expect(v).toBe('0.0.9');
    expect(MIN_AGENT365_VERSION).toBe('0.1.0');
  });
});

describe('agent365BlueprintCreate', () => {
  it('drives blueprint create via the spawn worker and resolves on success', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '0.2.0', stderr: '' })) as unknown as
      Parameters<typeof agent365BlueprintCreate>[1]['exec'];
    const spawnFn = vi.fn(async () =>
      fakeWorker('Blueprint scaffolded\n[agent365-done:0]\n'),
    ) as unknown as Parameters<typeof agent365BlueprintCreate>[1]['spawnFn'];
    await expect(
      agent365BlueprintCreate(
        { name: 'demo', projectPath: '/tmp/demo' },
        { exec, spawnFn },
      ),
    ).resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('rejects empty name with AppFactoryError', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '0.2.0', stderr: '' })) as unknown as
      Parameters<typeof agent365BlueprintCreate>[1]['exec'];
    await expect(
      agent365BlueprintCreate({ name: '', projectPath: '/p' }, { exec }),
    ).rejects.toMatchObject({ code: 'AGENT365_INPUT' });
  });

  it('surfaces ProvisioningError when the worker reports a non-zero exit', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '0.2.0', stderr: '' })) as unknown as
      Parameters<typeof agent365BlueprintCreate>[1]['exec'];
    const spawnFn = vi.fn(async () =>
      fakeWorker('something bad happened\n[agent365-done:1]\n'),
    ) as unknown as Parameters<typeof agent365BlueprintCreate>[1]['spawnFn'];
    await expect(
      agent365BlueprintCreate({ name: 'demo', projectPath: '/p' }, { exec, spawnFn }),
    ).rejects.toMatchObject({ code: 'PROVISIONING' });
  });
});

describe('agent365McpAdd', () => {
  it('invokes execa once per server in the list', async () => {
    const calls: { args: string[] }[] = [];
    const exec = vi.fn(async (_file: string, args: string[]) => {
      calls.push({ args });
      // first call is detectAgent365CliVersion --version
      if (args[0] === '--version') {
        return { exitCode: 0, stdout: '0.2.0', stderr: '' };
      }
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    }) as unknown as Parameters<typeof agent365McpAdd>[1]['exec'];
    await agent365McpAdd(
      {
        projectPath: '/p',
        servers: [
          { name: 'docs', url: 'https://mcp.example.com/docs' },
          { name: 'tickets', url: 'https://mcp.example.com/tickets' },
        ],
      },
      { exec },
    );
    // 1 version probe + 2 mcp add calls = 3 invocations
    expect(exec).toHaveBeenCalledTimes(3);
    const mcpCalls = calls.filter((c) => c.args[0] === 'mcp');
    expect(mcpCalls).toHaveLength(2);
    expect(mcpCalls[0]?.args).toContain('docs');
    expect(mcpCalls[1]?.args).toContain('tickets');
  });

  it('noops on an empty servers list', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '0.2.0',
      stderr: '',
    })) as unknown as Parameters<typeof agent365McpAdd>[1]['exec'];
    await agent365McpAdd({ projectPath: '/p', servers: [] }, { exec });
    // only the version probe runs
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('throws when a server is missing name or url', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '0.2.0',
      stderr: '',
    })) as unknown as Parameters<typeof agent365McpAdd>[1]['exec'];
    await expect(
      agent365McpAdd(
        { projectPath: '/p', servers: [{ name: '', url: 'x' }] },
        { exec },
      ),
    ).rejects.toMatchObject({ code: 'AGENT365_INPUT' });
  });
});

describe('agent365Publish', () => {
  it('drives publish via the spawn worker and resolves on success', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '0.2.0', stderr: '' })) as unknown as
      Parameters<typeof agent365Publish>[1]['exec'];
    const spawnFn = vi.fn(async () =>
      fakeWorker('published to dev\n[agent365-done:0]\n'),
    ) as unknown as Parameters<typeof agent365Publish>[1]['spawnFn'];
    await agent365Publish({ env: 'dev', projectPath: '/p' }, { exec, spawnFn });
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('rejects missing projectPath', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '0.2.0', stderr: '' })) as unknown as
      Parameters<typeof agent365Publish>[1]['exec'];
    await expect(
      agent365Publish({ env: 'dev', projectPath: '' }, { exec }),
    ).rejects.toMatchObject({ code: 'AGENT365_INPUT' });
  });
});

describe('agent365Clean', () => {
  it('invokes execa once with clean', async () => {
    const calls: { args: string[] }[] = [];
    const exec = vi.fn(async (_file: string, args: string[]) => {
      calls.push({ args });
      if (args[0] === '--version') return { exitCode: 0, stdout: '0.2.0', stderr: '' };
      return { exitCode: 0, stdout: 'cleaned', stderr: '' };
    }) as unknown as Parameters<typeof agent365Clean>[1]['exec'];
    await agent365Clean({ projectPath: '/p' }, { exec });
    expect(calls.some((c) => c.args[0] === 'clean')).toBe(true);
  });

  it('throws ProvisioningError when clean exits non-zero', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === '--version') return { exitCode: 0, stdout: '0.2.0', stderr: '' };
      return { exitCode: 2, stdout: '', stderr: 'no project' };
    }) as unknown as Parameters<typeof agent365Clean>[1]['exec'];
    await expect(agent365Clean({ projectPath: '/p' }, { exec })).rejects.toMatchObject({
      code: 'PROVISIONING',
    });
  });
});
