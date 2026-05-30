import { describe, it, expect, vi } from 'vitest';
import type { WorkerHandle } from '@app-factory/orchestrator';
import { activatePim } from '../src/pim.js';

function makeHandle(captureOutput = ''): WorkerHandle {
  return {
    id: 'h',
    session: 'app-factory',
    window: 'az-pim',
    command: '',
    send: vi.fn(async () => undefined),
    capture: vi.fn(async () => captureOutput),
    waitFor: vi.fn(async () => '[pim] activation step finished\nRole activation succeeded\n'),
    kill: vi.fn(async () => undefined),
  };
}

describe('activatePim', () => {
  it('spawns into the app-factory session with a bash -lc command containing the role + justification', async () => {
    const spawnFn = vi.fn(async (_cmd: string, _opts) => makeHandle());
    await activatePim({
      roleName: 'Application Administrator',
      justification: 'App Factory provisioning',
      spawnFn,
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const callArgs = spawnFn.mock.calls[0];
    if (!callArgs) throw new Error('expected spawn call');
    const [cmd, opts] = callArgs;
    expect(cmd.startsWith('bash -lc ')).toBe(true);
    expect(cmd).toContain('Application Administrator');
    expect(cmd).toContain('App Factory provisioning');
    expect(cmd).toContain('az account show');
    expect(cmd).toContain('az login --use-device-code');
    expect(opts?.name).toBe('az-pim');
    expect(opts?.session).toBe('app-factory');
  });

  it('marks alreadyActive when waitFor sees the "already active" marker', async () => {
    const handle: WorkerHandle = {
      ...makeHandle(),
      waitFor: vi.fn(async () => 'Cloud App Admin already active for user@contoso.com'),
    };
    const spawnFn = vi.fn(async () => handle);
    const result = await activatePim({
      roleName: 'Cloud Application Administrator',
      justification: 'unit test',
      spawnFn,
    });
    expect(result.alreadyActive).toBe(true);
  });

  it('throws AppFactoryError("PIM_ACTIVATION") on waitFor failure', async () => {
    const handle: WorkerHandle = {
      ...makeHandle(),
      waitFor: vi.fn(async () => {
        throw new Error('TIMEOUT');
      }),
    };
    const spawnFn = vi.fn(async () => handle);
    await expect(
      activatePim({ roleName: 'X', justification: 'y', spawnFn }),
    ).rejects.toMatchObject({ code: 'PIM_ACTIVATION' });
  });
});
