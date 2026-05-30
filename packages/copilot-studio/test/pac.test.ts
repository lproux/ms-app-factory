import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  assertPacInstalled,
  buildAuthCreateArgs,
  buildConnectorCreateArgs,
  buildEnvCreateArgs,
  buildEnvListArgs,
  buildSolutionAddReferenceArgs,
  buildSolutionExportArgs,
  buildSolutionImportArgs,
  buildSolutionInitArgs,
} from '../src/pac.js';
import { PortalRequiredError } from '@app-factory/shared';

const execaMock = execa as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  execaMock.mockReset();
});

describe('pac argv builders', () => {
  it('auth create (ServicePrincipal) wires all flags', () => {
    expect(
      buildAuthCreateArgs({
        kind: 'ServicePrincipal',
        tenant: 'contoso.onmicrosoft.com',
        applicationId: 'app-id',
        clientSecret: 'shh',
        name: 'cs-fleet',
      }),
    ).toEqual([
      'auth',
      'create',
      '--kind',
      'ServicePrincipal',
      '--name',
      'cs-fleet',
      '--tenant',
      'contoso.onmicrosoft.com',
      '--applicationId',
      'app-id',
      '--clientSecret',
      'shh',
    ]);
  });

  it('auth create (DeviceCode) omits sp-only flags', () => {
    expect(buildAuthCreateArgs({ kind: 'DeviceCode', tenant: 'contoso.com' })).toEqual([
      'auth',
      'create',
      '--kind',
      'DeviceCode',
      '--tenant',
      'contoso.com',
    ]);
  });

  it('env list/create/select args match expected pac surface', () => {
    expect(buildEnvListArgs()).toEqual(['env', 'list', '--json']);
    expect(buildEnvCreateArgs({ name: 'demo', region: 'unitedstates', type: 'Sandbox' })).toEqual([
      'env',
      'create',
      '--name',
      'demo',
      '--region',
      'unitedstates',
      '--type',
      'Sandbox',
    ]);
  });

  it('solution init/import/export/add-reference args use documented flags', () => {
    expect(
      buildSolutionInitArgs({
        publisherName: 'AppFactory',
        publisherPrefix: 'af',
        outputDirectory: '/tmp/sol',
      }),
    ).toEqual([
      'solution',
      'init',
      '--publisher-name',
      'AppFactory',
      '--publisher-prefix',
      'af',
      '--outputDirectory',
      '/tmp/sol',
    ]);
    expect(buildSolutionAddReferenceArgs('./other')).toEqual([
      'solution',
      'add-reference',
      '--path',
      './other',
    ]);
    expect(
      buildSolutionImportArgs('/tmp/x.zip', { envId: 'env-1', asyncWaitTimeMins: 5 }),
    ).toEqual([
      'solution',
      'import',
      '--path',
      '/tmp/x.zip',
      '--activate-plugins',
      '--async-wait-time',
      '5',
      '--environment',
      'env-1',
    ]);
    expect(
      buildSolutionExportArgs('/tmp/out.zip', {
        uniqueName: 'unique',
        managed: true,
        envId: 'env-1',
      }),
    ).toEqual([
      'solution',
      'export',
      '--path',
      '/tmp/out.zip',
      '--name',
      'unique',
      '--managed',
      '--environment',
      'env-1',
    ]);
  });

  it('connector create includes definition+properties+env when provided', () => {
    expect(
      buildConnectorCreateArgs({
        apiDefinitionFile: '/tmp/api.json',
        apiPropertiesFile: '/tmp/api.props.json',
        envId: 'env-9',
      }),
    ).toEqual([
      'connector',
      'create',
      '--api-definition-file',
      '/tmp/api.json',
      '--api-properties-file',
      '/tmp/api.props.json',
      '--environment',
      'env-9',
    ]);
  });
});

describe('assertPacInstalled', () => {
  it('throws PortalRequiredError pointing to the dotnet install command when pac is missing', async () => {
    execaMock.mockRejectedValueOnce(new Error('ENOENT pac'));
    await expect(assertPacInstalled()).rejects.toMatchObject({
      name: 'PortalRequiredError',
      portalUrl: 'https://learn.microsoft.com/power-platform/developer/cli/introduction',
    });
    execaMock.mockRejectedValueOnce(new Error('ENOENT pac'));
    await expect(assertPacInstalled()).rejects.toThrowError(
      /dotnet tool install --global Microsoft\.PowerApps\.CLI\.Tool/,
    );
    expect(PortalRequiredError).toBeDefined();
  });
});
