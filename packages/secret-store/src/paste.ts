import type { ArtifactRef } from '@app-factory/shared';

export interface PasteItem {
  scope: string;
  name: string;
  value: string;
  description?: string;
}

export interface CostSuggestion {
  resource: string;
  recommendation: string;
  estimatedMonthlySavingsUsd?: number;
  source?: string;
}

export interface PasteBundleOptions {
  title?: string;
  intro?: string;
  artifacts?: ArtifactRef[];
  warnings?: string[];
  costSuggestions?: CostSuggestion[];
  envPrefix?: string;
  /**
   * When true, embed raw secret values into the paste bundle. Default is
   * **false** — the bundle ships placeholder text (`<retrieve via SecretStore>`)
   * and the operator must opt in explicitly. This prevents tmux capture-pane,
   * CI logs, and terminal scrollback from harvesting the values that were
   * persisted to the OS keyring / Key Vault.
   */
  revealSecrets?: boolean;
}

const SECRET_PLACEHOLDER = '<retrieve via SecretStore.get(scope, name)>';

export function buildPasteBundle(items: PasteItem[], opts: PasteBundleOptions = {}): string {
  const title = opts.title ?? '# App Factory — run report';
  const intro =
    opts.intro ??
    '> Paste this entire block into Claude Code or `gh copilot` (clawpilot) to wire these artifacts and secrets into a downstream session.';

  const sections: string[] = [title, '', intro, ''];

  if (opts.artifacts && opts.artifacts.length > 0) {
    sections.push('## Artifacts', '');
    sections.push('| Kind | Id | Display name |');
    sections.push('| --- | --- | --- |');
    for (const a of opts.artifacts) {
      sections.push(`| ${a.kind} | ${escapeMd(a.id)} | ${escapeMd(a.displayName ?? '')} |`);
    }
    sections.push('');
  }

  if (items.length > 0) {
    const reveal = opts.revealSecrets === true;
    const renderValue = (it: PasteItem) => (reveal ? it.value : SECRET_PLACEHOLDER);

    sections.push('## Secrets', '');
    if (!reveal) {
      sections.push(
        '> Values redacted. Pass `--reveal-secrets` (or set `revealSecrets: true`) to render the actual secret material into this bundle. Until then, retrieve each entry via the SecretStore API or your Key Vault.',
      );
      sections.push('');
    }
    for (const it of items) {
      sections.push(`### ${it.scope} / ${it.name}`);
      if (it.description) sections.push(it.description);
      sections.push('```');
      sections.push(renderValue(it));
      sections.push('```');
      sections.push('');
    }

    sections.push('## `.env` block', '');
    sections.push('```dotenv');
    for (const it of items) {
      const raw = renderValue(it);
      sections.push(`${envKey(it.scope, it.name, opts.envPrefix)}=${reveal ? envValue(raw) : raw}`);
    }
    sections.push('```');
    sections.push('');

    sections.push('## clawpilot paste block', '');
    sections.push(
      '> Copy the entire block below into Claude Code (`/app-factory` skill) or `gh copilot` to re-hydrate this run.',
    );
    sections.push('');
    sections.push('```sh');
    sections.push('# App Factory — clawpilot paste bundle');
    for (const it of items) {
      const raw = renderValue(it);
      sections.push(`export ${envKey(it.scope, it.name, opts.envPrefix)}=${reveal ? shellQuote(raw) : shellQuote(raw)}`);
    }
    if (opts.artifacts) {
      for (const a of opts.artifacts) {
        sections.push(`# artifact ${a.kind}: ${a.id}${a.displayName ? ` (${a.displayName})` : ''}`);
      }
    }
    sections.push('```');
    sections.push('');
  }

  if (opts.warnings && opts.warnings.length > 0) {
    sections.push('## Warnings', '');
    for (const w of opts.warnings) sections.push(`- ${w}`);
    sections.push('');
  }

  if (opts.costSuggestions && opts.costSuggestions.length > 0) {
    sections.push('## Cost optimizer suggestions', '');
    sections.push('| Resource | Recommendation | Est. monthly savings (USD) | Source |');
    sections.push('| --- | --- | --- | --- |');
    for (const c of opts.costSuggestions) {
      const sav = c.estimatedMonthlySavingsUsd != null ? c.estimatedMonthlySavingsUsd.toFixed(2) : '';
      sections.push(`| ${escapeMd(c.resource)} | ${escapeMd(c.recommendation)} | ${sav} | ${escapeMd(c.source ?? '')} |`);
    }
    sections.push('');
  }

  return sections.join('\n');
}

function envKey(scope: string, name: string, prefix?: string): string {
  const slug = `${scope}__${name}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return `${(prefix ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '_')}${slug}`;
}

function envValue(value: string): string {
  if (/^[A-Za-z0-9_./:@\-]+$/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeMd(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
