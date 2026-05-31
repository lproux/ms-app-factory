/**
 * packages/judge-panel/test/judge-step.test.ts
 *
 * Covers the extracted `runJudgePanelStep` helper shared between A11 and
 * B13. Three scenarios:
 *   1. happy path — no veto, returns the passing PanelResult.
 *   2. converge after one veto round — autoImprove regenerates, second
 *      pass clears, runJudgePanelStep returns the passing PanelResult.
 *   3. maxRounds exhaustion — JudgeVetoError is caught, a synthetic
 *      vetoed PanelResult is returned, and the **real** persona from
 *      `votes[i].judge.split(':')[1]` is preserved on each verdict.
 *
 * Strategy: mock the three judge-factory modules so `buildJudgePanel`
 * (which `runJudgePanelStep` constructs internally) wires up scripted
 * deterministic judges instead of network-backed real ones. A shared
 * mutable `scriptByPersona` cursor lets each test inject a different
 * round-by-round verdict sequence per persona.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { FactoryContext } from '@app-factory/shared';

// Mutable per-test scripts: keyed by persona, each value is the
// sequence of approved booleans that *every model's* judge for that
// persona will replay in order on successive review() calls.
const scriptByPersona: Record<string, boolean[]> = {};
const callCounters: Record<string, number> = {};

function scriptedReview(model: string, persona: string) {
  return async () => {
    const key = `${model}:${persona}`;
    const i = callCounters[key] ?? 0;
    callCounters[key] = i + 1;
    const script = scriptByPersona[persona] ?? [true];
    const approved = script[Math.min(i, script.length - 1)] ?? true;
    return {
      judge: key,
      persona,
      approved,
      reason: approved ? 'looks good' : `${persona} rejects: needs work`,
      repairNotes: approved ? undefined : `${persona}: repair me`,
    };
  };
}

const noopCombined = (id: string) => ({
  id,
  personas: [] as string[],
  async review() {
    return [];
  },
});

vi.mock('../src/judges/claude.js', () => ({
  makeClaudeJudge: (opts: { persona: string }) => ({
    id: `claude:${opts.persona}`,
    persona: opts.persona,
    review: scriptedReview('claude', opts.persona),
  }),
  makeClaudeCombinedJudge: () => noopCombined('claude:combined'),
}));

vi.mock('../src/judges/copilot.js', () => ({
  makeGhCopilotJudge: (opts: { persona: string }) => ({
    id: `copilot:${opts.persona}`,
    persona: opts.persona,
    review: scriptedReview('copilot', opts.persona),
  }),
  makeGhCopilotCombinedJudge: () => noopCombined('copilot:combined'),
}));

vi.mock('../src/judges/copilot-studio.js', () => ({
  makeCopilotStudioJudge: (opts: { persona: string }) => ({
    id: `cs:${opts.persona}`,
    persona: opts.persona,
    review: scriptedReview('cs', opts.persona),
  }),
  makeCopilotStudioCombinedJudge: () => noopCombined('cs:combined'),
}));

// Imports of the SUT happen AFTER the vi.mock declarations so the
// mocked judge factories are wired into `buildJudgePanel`.
import { runJudgePanelStep, personaFromJudgeId } from '../src/judge-step.js';
import type { JudgeArtifact } from '../src/types.js';

interface FakeCtx {
  fctx: FactoryContext;
  warnings: string[];
}

function fakeFctx(
  maxRounds = 3,
  shape: 'compact' | 'cross-model' | 'full' = 'cross-model',
): FactoryContext {
  return {
    runId: 'judge-step-test',
    recipe: 'copilot-studio-custom',
    planOnly: false,
    workdir: '/tmp/jstep',
    kbSources: [],
    auth: { mode: 'chained' },
    emit: { keyring: true, revealSecrets: false },
    judge: { shape, maxRounds },
  } as unknown as FactoryContext;
}

beforeEach(() => {
  for (const key of Object.keys(scriptByPersona)) delete scriptByPersona[key];
  for (const key of Object.keys(callCounters)) delete callCounters[key];
});

describe('runJudgePanelStep', () => {
  it('happy path: all judges approve → returns passing PanelResult', async () => {
    scriptByPersona.architect = [true];
    scriptByPersona.security = [true];
    scriptByPersona.cost = [true];
    scriptByPersona.ux = [true];

    const ctx: FakeCtx = { fctx: fakeFctx(3), warnings: [] };
    const buildArtifact = (notes: string[]): JudgeArtifact => ({
      kind: 'cs-agent',
      id: 'happy-1',
      summary: `notes=${notes.length}`,
    });

    const result = await runJudgePanelStep<FakeCtx>({ ctx, kind: 'A11', buildArtifact });

    expect(result.panel.vetoed).toBe(false);
    expect(result.panel.rejections).toBe(0);
    expect(result.panel.approvals).toBeGreaterThan(0);
    expect(ctx.warnings).toEqual([]);
  });

  it('converges after one veto round: regenerate runs, second pass clears', async () => {
    // Architect/cost/ux approve; security rejects round 1 then approves round 2.
    scriptByPersona.architect = [true];
    scriptByPersona.security = [false, true];
    scriptByPersona.cost = [true];
    scriptByPersona.ux = [true];

    const ctx: FakeCtx = { fctx: fakeFctx(3), warnings: [] };
    let buildCalls = 0;
    const buildArtifact = (notes: string[]): JudgeArtifact => {
      buildCalls += 1;
      return {
        kind: 'cs-agent',
        id: `converge-${buildCalls}`,
        summary: `round=${buildCalls} notes=${notes.length}`,
      };
    };

    const result = await runJudgePanelStep<FakeCtx>({ ctx, kind: 'A11', buildArtifact });

    expect(buildCalls).toBeGreaterThanOrEqual(2);
    expect(result.panel.vetoed).toBe(false);
    expect(ctx.warnings.some((w) => w.includes('auto-improve repair notes'))).toBe(true);
  });

  it('maxRounds exhaustion → synthetic PanelResult preserves real persona from votes[i].judge', async () => {
    // Security always rejects; other personas approve. With maxRounds=1
    // the first failing review immediately throws JudgeVetoError.
    scriptByPersona.architect = [true];
    scriptByPersona.security = [false];
    scriptByPersona.cost = [true];
    scriptByPersona.ux = [true];

    const ctx: FakeCtx = { fctx: fakeFctx(1), warnings: [] };
    const buildArtifact = (_notes: string[]): JudgeArtifact => ({
      kind: 'cs-agent',
      id: 'veto-1',
      summary: 'rejecting',
    });

    const result = await runJudgePanelStep<FakeCtx>({ ctx, kind: 'A11', buildArtifact });

    expect(result.panel.vetoed).toBe(true);
    expect(result.panel.rejections).toBeGreaterThan(0);
    expect(result.panel.verdicts.length).toBeGreaterThan(0);
    // CRITICAL: each synthetic verdict carries the *real* persona, not
    // a hard-coded 'architect'. With security as the sole rejecting
    // persona, every recorded vote's judge id must end with `:security`
    // and decode to the 'security' persona.
    for (const v of result.panel.verdicts) {
      expect(v.persona).toBe('security');
      expect(v.judge.endsWith(':security')).toBe(true);
    }
    expect(ctx.warnings.some((w) => w.includes('judge veto after auto-improve'))).toBe(true);
  });
});

describe('personaFromJudgeId', () => {
  it('decodes the canonical `model:persona` id', () => {
    expect(personaFromJudgeId('claude:architect')).toBe('architect');
    expect(personaFromJudgeId('copilot:security')).toBe('security');
    expect(personaFromJudgeId('cs:cost')).toBe('cost');
    expect(personaFromJudgeId('cs:ux')).toBe('ux');
  });

  it('strips the :unavailable suffix and still resolves the persona', () => {
    expect(personaFromJudgeId('claude:security:unavailable')).toBe('security');
  });

  it('falls back to architect for combined or non-persona ids', () => {
    expect(personaFromJudgeId('claude:combined')).toBe('architect');
    expect(personaFromJudgeId('unknown')).toBe('architect');
  });
});
