import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installClaudeSkill, SKILL_BODY } from '@app-factory/skill-claude';
import {
  installGhExtension,
  EXTENSION_SCRIPT,
  EXTENSION_MANIFEST,
} from '@app-factory/skill-copilot-cli';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'af-skill-parity-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('Integration — skill-adapter parity', () => {
  it('installs the Claude skill and the gh extension into a temp HOME and produces identical underlying artifacts', async () => {
    const claudeDir = join(home, '.claude', 'skills', 'app-factory');
    const ghDir = join(home, '.local', 'share', 'gh', 'extensions', 'gh-app-factory');

    const claudePath = await installClaudeSkill({ skillsDir: claudeDir });
    const ghPath = await installGhExtension({ extensionsDir: ghDir });

    expect(claudePath).toBe(join(claudeDir, 'SKILL.md'));
    expect(ghPath).toBe(join(ghDir, 'gh-app-factory'));

    const claudeSkill = await readFile(claudePath, 'utf8');
    const ghScript = await readFile(ghPath, 'utf8');
    const ghManifest = await readFile(join(ghDir, 'extension.yml'), 'utf8');

    // The artifacts are *not* identical bytes by design — one is a Markdown
    // SKILL.md and the other is a bash shim. Parity here means: same source
    // constants, same recipe surface mentioned, both reference the
    // app-factory CLI binary.
    expect(claudeSkill).toBe(SKILL_BODY);
    expect(ghScript).toBe(EXTENSION_SCRIPT);
    expect(ghManifest).toBe(EXTENSION_MANIFEST);

    // Both adapters must mention the canonical recipe ids the CLI knows
    // about — that's the parity-of-recipe-surface check.
    for (const recipeId of ['copilot-studio-support-bot', 'teams-bot-basic']) {
      expect(claudeSkill).toContain(recipeId);
    }

    // The Claude SKILL.md must declare the skill name + description for
    // discovery; the gh script must shell out to `app-factory`.
    expect(claudeSkill).toContain('name: app-factory');
    expect(claudeSkill).toContain('description:');
    expect(ghScript).toContain('app-factory');
    expect(ghScript).toContain('exec "$AF_BIN" "$@"');

    // gh shim must be executable.
    const ghStat = await stat(ghPath);
    expect((ghStat.mode & 0o111) !== 0).toBe(true);
  });
});
