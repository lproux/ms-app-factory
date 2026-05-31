import { describe, it, expect, vi } from 'vitest';
import { makeCliWrapper } from '../src/cli-runner.js';
import type { WorkerHandle } from '../src/tmux.js';

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

describe('makeCliWrapper.detectVersion', () => {
  it('throws PortalRequiredError with installHint when binary returns non-zero', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
      portalUrl: 'https://example.com/demo',
    });
    const exec = vi.fn(async () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'command not found',
    })) as unknown as Parameters<typeof wrapper.detectVersion>[0]['exec'];
    await expect(wrapper.detectVersion({ exec })).rejects.toMatchObject({
      code: 'PORTAL_REQUIRED',
      portalUrl: 'https://example.com/demo',
      message: expect.stringContaining('npm i -g demo-cli'),
    });
  });

  it('throws PortalRequiredError when exec itself throws', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const exec = vi.fn(async () => {
      throw new Error('ENOENT');
    }) as unknown as Parameters<typeof wrapper.detectVersion>[0]['exec'];
    await expect(wrapper.detectVersion({ exec })).rejects.toMatchObject({
      code: 'PORTAL_REQUIRED',
    });
  });

  it('caches the version across calls (exec invoked once)', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '1.2.3',
      stderr: '',
    })) as unknown as Parameters<typeof wrapper.detectVersion>[0]['exec'];
    const a = await wrapper.detectVersion({ exec });
    const b = await wrapper.detectVersion({ exec });
    expect(a).toBe('1.2.3');
    expect(b).toBe('1.2.3');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('returns the version (no throw) when below minVersion — warn-only', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      minVersion: '2.0.0',
      installHint: 'npm i -g demo-cli',
    });
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '1.0.0',
      stderr: '',
    })) as unknown as Parameters<typeof wrapper.detectVersion>[0]['exec'];
    const v = await wrapper.detectVersion({ exec });
    expect(v).toBe('1.0.0');
  });

  it('resetVersionCache forces re-probing', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '1.2.3',
      stderr: '',
    })) as unknown as Parameters<typeof wrapper.detectVersion>[0]['exec'];
    await wrapper.detectVersion({ exec });
    wrapper.resetVersionCache();
    await wrapper.detectVersion({ exec });
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('makeCliWrapper.runInTmux', () => {
  it('returns the captured pane buffer when the marker shows exit 0', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const buf = 'all good\n[demo-cli-done:0]\n';
    const spawnFn = vi.fn(async () => fakeWorker(buf)) as unknown as Parameters<
      typeof wrapper.runInTmux
    >[0]['spawnFn'];
    const result = await wrapper.runInTmux({
      name: 'demo-step',
      args: ['do', 'thing'],
      cwd: '/p',
      spawnFn,
    });
    expect(result).toBe(buf);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    // Sanity: the command we asked tmux to run shell-quoted the args and
    // included the marker echo.
    const calledCmd = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as string;
    expect(calledCmd).toContain("'do'");
    expect(calledCmd).toContain("'thing'");
    expect(calledCmd).toContain('[demo-cli-done:$?]');
  });

  it('throws ProvisioningError when the marker reports a non-zero exit', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const spawnFn = vi.fn(async () =>
      fakeWorker('boom\n[demo-cli-done:1]\n'),
    ) as unknown as Parameters<typeof wrapper.runInTmux>[0]['spawnFn'];
    await expect(
      wrapper.runInTmux({ name: 'demo-step', args: ['x'], cwd: '/p', spawnFn }),
    ).rejects.toMatchObject({
      code: 'PROVISIONING',
      message: expect.stringContaining('exit 1'),
    });
  });

  it('honours a custom marker name', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
      marker: 'custom-marker',
    });
    const spawnFn = vi.fn(async () =>
      fakeWorker('done\n[custom-marker:0]\n'),
    ) as unknown as Parameters<typeof wrapper.runInTmux>[0]['spawnFn'];
    await wrapper.runInTmux({ name: 'x', args: [], cwd: '/p', spawnFn });
    const calledCmd = (spawnFn as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as string;
    expect(calledCmd).toContain('[custom-marker:$?]');
  });

  it('throws ProvisioningError when failureRegex matches and successRegex does not', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const spawnFn = vi.fn(async () =>
      fakeWorker('something went wrong: failed step\n[demo-cli-done:0]\n'),
    ) as unknown as Parameters<typeof wrapper.runInTmux>[0]['spawnFn'];
    await expect(
      wrapper.runInTmux({
        name: 'demo-step',
        args: [],
        cwd: '/p',
        spawnFn,
        successRegex: /completed successfully/i,
      }),
    ).rejects.toMatchObject({
      code: 'PROVISIONING',
      message: expect.stringContaining('failure markers'),
    });
  });
});

describe('makeCliWrapper.run', () => {
  it('returns { stdout, stderr } on exit 0', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'hi',
      stderr: 'noise',
    })) as unknown as Parameters<typeof wrapper.run>[0]['exec'];
    const out = await wrapper.run({ args: ['noop'], cwd: '/p', exec });
    expect(out).toEqual({ stdout: 'hi', stderr: 'noise' });
  });

  it('throws ProvisioningError on non-zero exit', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    const exec = vi.fn(async () => ({
      exitCode: 2,
      stdout: '',
      stderr: 'kaboom',
    })) as unknown as Parameters<typeof wrapper.run>[0]['exec'];
    await expect(
      wrapper.run({ args: ['fail'], cwd: '/p', exec, name: 'noop' }),
    ).rejects.toMatchObject({
      code: 'PROVISIONING',
      message: expect.stringContaining('exit 2'),
    });
  });

  it('passes cwd + env through to exec', async () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      installHint: 'npm i -g demo-cli',
    });
    let captured: { cwd?: unknown; env?: unknown } = {};
    const exec = vi.fn(async (_file: string, _args: string[], opts?: { cwd?: unknown; env?: unknown }) => {
      captured = { cwd: opts?.cwd, env: opts?.env };
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    }) as unknown as Parameters<typeof wrapper.run>[0]['exec'];
    await wrapper.run({
      args: ['noop'],
      cwd: '/p',
      env: { FOO: 'bar', UNSET: undefined },
      exec,
    });
    expect(captured.cwd).toBe('/p');
    expect(captured.env).toEqual({ FOO: 'bar' });
  });
});

describe('makeCliWrapper.config', () => {
  it('exposes the immutable resolved config', () => {
    const wrapper = makeCliWrapper({
      bin: 'demo-cli',
      name: 'Demo CLI',
      minVersion: '1.0.0',
      installHint: 'npm i -g demo-cli',
      portalUrl: 'https://example.com',
    });
    expect(wrapper.config.bin).toBe('demo-cli');
    expect(wrapper.config.marker).toBe('demo-cli-done');
    expect(wrapper.config.portalUrl).toBe('https://example.com');
    expect(wrapper.config.minVersion).toBe('1.0.0');
  });
});
