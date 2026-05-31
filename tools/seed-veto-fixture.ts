#!/usr/bin/env node
/**
 * tools/seed-veto-fixture.ts
 *
 * Emit a JSON fixture that mirrors what a real Copilot Studio (WBS-A5/A6)
 * run would produce for a "support bot" agent, deliberately wired with an
 * EMPTY `generativeAnswers.sources` array so the judge panel can flag a
 * KB-grounding veto.
 *
 * Two flavours are emitted:
 *   - "broken":  the deliberate regression — generativeAnswers.enabled: true,
 *                sources: []. This is the input to the judge-panel veto path.
 *   - "repaired": what the auto-improve loop should produce — a non-empty
 *                 `sources` array drawn from `kbSources`.
 *
 * Shape matches `AgentDefinition` from
 *   packages/copilot-studio/src/agent-definition.ts
 * and the WBS-A5 transform in packages/copilot-studio/src/index.ts which
 * maps `fctx.kbSources` to `${kind}:${uri}` strings.
 *
 * Usage (from repo root):
 *   pnpm tsx tools/seed-veto-fixture.ts                   # writes both to .fixtures/
 *   pnpm tsx tools/seed-veto-fixture.ts --print broken    # prints broken to stdout
 *   pnpm tsx tools/seed-veto-fixture.ts --print repaired  # prints repaired to stdout
 *
 * The judge-panel tests import the builder functions directly; the CLI
 * entrypoint exists so a human can eyeball the JSON.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface KbSource {
  kind: 'local' | 'sharepoint' | 'url' | 'github' | 'aws' | 'gcp';
  uri: string;
}

export interface SeedAgentArtifact {
  kind: 'cs-agent';
  id: string;
  displayName: string;
  summary: string;
  payload: {
    uniqueName: string;
    displayName: string;
    description: string;
    instructions: string;
    greeting: string;
    topics: Array<{
      name: string;
      triggerPhrases: string[];
      nodes: Array<{ kind: string; text?: string }>;
    }>;
    generativeAnswers: { enabled: boolean; sources: string[] };
    brand: { primaryColor: string };
    kbSources: KbSource[];
  };
}

const KB_SOURCES: KbSource[] = [
  { kind: 'local', uri: './docs/support-faq.md' },
  { kind: 'sharepoint', uri: 'https://contoso.sharepoint.com/sites/support/Shared Documents' },
  { kind: 'url', uri: 'https://learn.microsoft.com/en-us/copilot-studio/' },
];

const BASE_PAYLOAD: Omit<SeedAgentArtifact['payload'], 'generativeAnswers'> = {
  uniqueName: 'af_support_bot',
  displayName: 'Contoso Support Bot',
  description: 'Customer support bot grounded in the Contoso docs site.',
  instructions:
    'You are a friendly Contoso support assistant. Use the knowledge base to answer ' +
    'product questions. If the KB is silent, say so and offer to open a ticket.',
  greeting: "Hi! I'm the Contoso support bot. What can I help you with today?",
  topics: [
    {
      name: 'Greeting',
      triggerPhrases: ['hi', 'hello', 'hey', 'good morning'],
      nodes: [{ kind: 'message', text: "Hi! I'm the Contoso support bot." }],
    },
    {
      name: 'Fallback',
      triggerPhrases: ['__fallback__'],
      nodes: [
        {
          kind: 'message',
          text: "I'm not sure about that yet. Could you rephrase or ask something more specific?",
        },
      ],
    },
  ],
  brand: { primaryColor: '#0062AD' },
  kbSources: KB_SOURCES,
};

/** The deliberate regression: GA enabled, but sources is empty. */
export function buildBrokenFixture(): SeedAgentArtifact {
  return {
    kind: 'cs-agent',
    id: 'cs-agent:contoso-support-bot:broken',
    displayName: BASE_PAYLOAD.displayName,
    summary:
      'Contoso support bot, generative answers enabled but no KB sources wired — ' +
      'deliberate KB-grounding regression for judge-panel veto testing.',
    payload: {
      ...BASE_PAYLOAD,
      generativeAnswers: { enabled: true, sources: [] },
    },
  };
}

/** What auto-improve should produce: GA enabled, sources mapped from kbSources. */
export function buildRepairedFixture(): SeedAgentArtifact {
  return {
    kind: 'cs-agent',
    id: 'cs-agent:contoso-support-bot:repaired',
    displayName: BASE_PAYLOAD.displayName,
    summary:
      'Contoso support bot with generative answers enabled and KB sources wired ' +
      'from the configured kbSources.',
    payload: {
      ...BASE_PAYLOAD,
      generativeAnswers: {
        enabled: true,
        sources: BASE_PAYLOAD.kbSources.map((s) => `${s.kind}:${s.uri}`),
      },
    },
  };
}

export interface SeedFixtureBundle {
  broken: SeedAgentArtifact;
  repaired: SeedAgentArtifact;
}

export function buildFixtureBundle(): SeedFixtureBundle {
  return { broken: buildBrokenFixture(), repaired: buildRepairedFixture() };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<void> {
  const printIdx = argv.indexOf('--print');
  if (printIdx !== -1) {
    const which = argv[printIdx + 1];
    const fixture =
      which === 'repaired'
        ? buildRepairedFixture()
        : which === 'broken'
          ? buildBrokenFixture()
          : undefined;
    if (!fixture) {
      process.stderr.write('usage: seed-veto-fixture.ts --print <broken|repaired>\n');
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(fixture, null, 2)}\n`);
    return;
  }

  const outDirIdx = argv.indexOf('--out');
  const outDir = outDirIdx !== -1 ? argv[outDirIdx + 1] : undefined;
  const targetDir = outDir
    ? path.resolve(outDir)
    : path.resolve(process.cwd(), '.fixtures', 'judge-panel');
  await fs.mkdir(targetDir, { recursive: true });
  const bundle = buildFixtureBundle();
  const brokenPath = path.join(targetDir, 'cs-agent-broken.json');
  const repairedPath = path.join(targetDir, 'cs-agent-repaired.json');
  await fs.writeFile(brokenPath, `${JSON.stringify(bundle.broken, null, 2)}\n`, 'utf8');
  await fs.writeFile(repairedPath, `${JSON.stringify(bundle.repaired, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${brokenPath}\nwrote ${repairedPath}\n`);
}

// ESM-safe "is this the entry script" check.
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
}
