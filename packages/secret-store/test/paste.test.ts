import { describe, expect, it } from 'vitest';
import { buildPasteBundle } from '../src/paste.js';

describe('buildPasteBundle', () => {
  it('emits sections, .env block, and clawpilot block for items', () => {
    const md = buildPasteBundle(
      [
        { scope: 'teams-app', name: 'entra-client-secret', value: 'abc123', description: 'Entra app secret' },
        { scope: 'copilot-studio', name: 'pac-auth', value: 'profile=af-dev', description: 'pac auth name' },
      ],
      {
        artifacts: [
          { kind: 'entra-app', id: 'app-1', displayName: 'helpdesk' },
          { kind: 'bot', id: 'bot-1' },
        ],
        warnings: ['playwright not installed'],
        costSuggestions: [
          { resource: 'rg-helpdesk', recommendation: 'switch to Spot VMs', estimatedMonthlySavingsUsd: 12.34, source: 'Azure Advisor' },
        ],
      },
    );

    expect(md).toContain('## Secrets');
    expect(md).toContain('### teams-app / entra-client-secret');
    expect(md).toContain('## `.env` block');
    expect(md).toContain('TEAMS_APP__ENTRA_CLIENT_SECRET=abc123');
    expect(md).toContain('COPILOT_STUDIO__PAC_AUTH=');
    expect(md).toContain('## clawpilot paste block');
    expect(md).toContain("export TEAMS_APP__ENTRA_CLIENT_SECRET='abc123'");
    expect(md).toContain('## Artifacts');
    expect(md).toContain('| entra-app | app-1 | helpdesk |');
    expect(md).toContain('## Warnings');
    expect(md).toContain('- playwright not installed');
    expect(md).toContain('## Cost optimizer suggestions');
    expect(md).toContain('| rg-helpdesk | switch to Spot VMs | 12.34 | Azure Advisor |');
  });

  it('quotes values containing whitespace or special characters', () => {
    const md = buildPasteBundle([{ scope: 's', name: 'n', value: 'hello world & "tricky"' }]);
    expect(md).toContain('S__N="hello world & \\"tricky\\""');
    expect(md).toContain("export S__N='hello world & \"tricky\"'");
  });

  it('omits artifact/warning/cost sections when not provided', () => {
    const md = buildPasteBundle([{ scope: 'x', name: 'y', value: '1' }]);
    expect(md).not.toContain('## Artifacts');
    expect(md).not.toContain('## Warnings');
    expect(md).not.toContain('## Cost optimizer suggestions');
    expect(md).toContain('## Secrets');
  });

  it('respects custom envPrefix and title', () => {
    const md = buildPasteBundle([{ scope: 's', name: 'n', value: 'v' }], {
      title: '# Custom',
      envPrefix: 'AF_',
    });
    expect(md.startsWith('# Custom')).toBe(true);
    expect(md).toContain('AF_S__N=v');
  });
});
