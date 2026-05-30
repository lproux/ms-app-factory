import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildAtkNewArgs,
  buildAtkProvisionArgs,
  buildAtkDeployArgs,
  buildAtkPackageArgs,
  buildAtkValidateArgs,
  buildAtkUpdateTeamsAppArgs,
  buildAtkPreviewArgs,
  assertAtkInstalled,
  _resetAtkVersionCache,
  MIN_ATK_VERSION,
} from '../src/atk.js';

beforeEach(() => {
  _resetAtkVersionCache();
});

describe('atk arg builders', () => {
  it('buildAtkNewArgs forms non-interactive new args with optional capability', () => {
    expect(buildAtkNewArgs({ template: 'bot', name: 'mybot', folder: '/work' })).toEqual([
      'new',
      '--template',
      'bot',
      '--app-name',
      'mybot',
      '--folder',
      '/work',
      '--interactive',
      'false',
    ]);
    expect(
      buildAtkNewArgs({ template: 'tab', name: 'tabx', folder: '/w', capability: 'tab' }),
    ).toContain('--capability');
  });

  it('buildAtkProvisionArgs / Deploy / Package include env + non-interactive', () => {
    expect(buildAtkProvisionArgs({ env: 'dev', projectPath: '/p' })).toEqual([
      'provision',
      '--env',
      'dev',
      '--interactive',
      'false',
    ]);
    expect(buildAtkDeployArgs({ env: 'staging', projectPath: '/p' })).toContain('staging');
    expect(
      buildAtkPackageArgs({ env: 'dev', projectPath: '/p', outDir: '/p/appPackage/build' }),
    ).toEqual([
      'package',
      '--env',
      'dev',
      '--output-folder',
      '/p/appPackage/build',
      '--interactive',
      'false',
    ]);
  });

  it('buildAtkValidateArgs supports both manifestPath and appPackagePath flavours', () => {
    const manifest = buildAtkValidateArgs({
      manifestPath: '/p/appPackage/manifest.json',
      projectPath: '/p',
    });
    expect(manifest).toContain('--manifest-path');
    expect(manifest).toContain('/p/appPackage/manifest.json');

    const pkg = buildAtkValidateArgs({
      appPackagePath: '/p/build/appPackage.dev.zip',
      projectPath: '/p',
      env: 'dev',
    });
    expect(pkg).toContain('--app-package-file-path');
    expect(pkg).toContain('--env');
  });

  it('buildAtkUpdateTeamsAppArgs emits update teams-app', () => {
    expect(buildAtkUpdateTeamsAppArgs({ env: 'dev', projectPath: '/p' })).toEqual([
      'update',
      'teams-app',
      '--env',
      'dev',
      '--interactive',
      'false',
    ]);
  });

  it('buildAtkPreviewArgs honours openBrowser=false', () => {
    expect(
      buildAtkPreviewArgs({ env: 'dev', projectPath: '/p', openBrowser: false }),
    ).toContain('--no-browser');
    expect(buildAtkPreviewArgs({ env: 'dev', projectPath: '/p', openBrowser: true })).not.toContain(
      '--no-browser',
    );
  });
});

describe('assertAtkInstalled', () => {
  it('throws PortalRequiredError with the install hint when atk --version fails', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 127,
      stdout: '',
      stderr: 'command not found',
    })) as unknown as Parameters<typeof assertAtkInstalled>[0]['exec'];
    await expect(assertAtkInstalled({ exec })).rejects.toMatchObject({
      code: 'PORTAL_REQUIRED',
      portalUrl: 'https://learn.microsoft.com/microsoftteams/platform/toolkit/teams-toolkit-cli',
      message: expect.stringContaining('npm install -g @microsoft/m365agentstoolkit-cli'),
    });
  });

  it('throws PortalRequiredError when exec itself throws', async () => {
    const exec = vi.fn(async () => {
      throw new Error('ENOENT');
    }) as unknown as Parameters<typeof assertAtkInstalled>[0]['exec'];
    await expect(assertAtkInstalled({ exec })).rejects.toMatchObject({ code: 'PORTAL_REQUIRED' });
  });

  it('returns the version string on success', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '3.1.0',
      stderr: '',
    })) as unknown as Parameters<typeof assertAtkInstalled>[0]['exec'];
    const v = await assertAtkInstalled({ exec });
    expect(v).toBe('3.1.0');
  });

  it('still resolves when version is older than MIN_ATK_VERSION (warns only)', async () => {
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '2.9.9',
      stderr: '',
    })) as unknown as Parameters<typeof assertAtkInstalled>[0]['exec'];
    const v = await assertAtkInstalled({ exec });
    expect(v).toBe('2.9.9');
    expect(MIN_ATK_VERSION).toBe('3.0.0');
  });
});
