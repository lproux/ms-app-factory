/**
 * packages/judge-panel/test/panel-shape.test.ts
 *
 * Verifies the configurable panel-shape contract (compact / cross-model /
 * full). Uses stub judge factories so no LLM calls happen; asserts the
 * judge count produced by each shape and that `compact` emits ONE combined
 * verdict bundle per call (i.e. one round-trip per model, not one per
 * persona).
 */

import { describe, expect, it } from 'vitest';
import { buildJudgePanel } from '../src/build-panel.js';
import type {
  CombinedJudge,
  Judge,
  JudgeArtifact,
  Persona,
  Verdict,
} from '../src/types.js';

const PERSONAS: Persona[] = ['architect', 'security', 'cost', 'ux'];

const ARTIFACT: JudgeArtifact = {
  kind: 'cs-agent',
  id: 'panel-shape-fixture',
  summary: 'shape-test artifact',
  payload: { topics: [{ name: 'Greeting' }], generativeAnswers: { sources: ['kb://stub'] } },
};

interface CallTracker {
  singleCalls: Array<{ id: string; persona: Persona }>;
  combinedCalls: Array<{ id: string; personas: Persona[] }>;
}

function makeTracker(): CallTracker {
  return { singleCalls: [], combinedCalls: [] };
}

function stubFactories(tracker: CallTracker, modelTag: string) {
  return {
    claude: ({ persona }: { persona: Persona }): Judge => ({
      id: `claude:${persona}`,
      persona,
      async review(): Promise<Verdict> {
        tracker.singleCalls.push({ id: `claude:${persona}`, persona });
        return { judge: `claude:${persona}`, persona, approved: true, reason: `${modelTag}-ok` };
      },
    }),
    copilot: ({ persona }: { persona: Persona }): Judge => ({
      id: `copilot:${persona}`,
      persona,
      async review(): Promise<Verdict> {
        tracker.singleCalls.push({ id: `copilot:${persona}`, persona });
        return { judge: `copilot:${persona}`, persona, approved: true, reason: `${modelTag}-ok` };
      },
    }),
    copilotStudio: ({ persona }: { persona: Persona }): Judge => ({
      id: `cs:${persona}`,
      persona,
      async review(): Promise<Verdict> {
        tracker.singleCalls.push({ id: `cs:${persona}`, persona });
        return { judge: `cs:${persona}`, persona, approved: true, reason: `${modelTag}-ok` };
      },
    }),
    claudeCombined: ({ personas }: { personas: Persona[] }): CombinedJudge => ({
      id: 'claude:combined',
      personas,
      async review(): Promise<Verdict[]> {
        tracker.combinedCalls.push({ id: 'claude:combined', personas });
        return personas.map((p) => ({
          judge: 'claude:combined',
          persona: p,
          approved: true,
          reason: `combined-ok-${p}`,
        }));
      },
    }),
    copilotCombined: ({ personas }: { personas: Persona[] }): CombinedJudge => ({
      id: 'copilot:combined',
      personas,
      async review(): Promise<Verdict[]> {
        tracker.combinedCalls.push({ id: 'copilot:combined', personas });
        return personas.map((p) => ({
          judge: 'copilot:combined',
          persona: p,
          approved: true,
          reason: `combined-ok-${p}`,
        }));
      },
    }),
    copilotStudioCombined: ({ personas }: { personas: Persona[] }): CombinedJudge => ({
      id: 'cs:combined',
      personas,
      async review(): Promise<Verdict[]> {
        tracker.combinedCalls.push({ id: 'cs:combined', personas });
        return personas.map((p) => ({
          judge: 'cs:combined',
          persona: p,
          approved: true,
          reason: `combined-ok-${p}`,
        }));
      },
    }),
  };
}

describe('buildJudgePanel shape contract', () => {
  it('compact shape: 3 combined judges, 3 round-trips total, 12 verdicts', async () => {
    const tracker = makeTracker();
    const panel = buildJudgePanel({
      shape: 'compact',
      personas: PERSONAS,
      factories: stubFactories(tracker, 'compact'),
    });

    const result = await panel.review(ARTIFACT);

    // 3 combined judges (claude/copilot/cs) each called exactly once.
    expect(tracker.combinedCalls).toHaveLength(3);
    expect(tracker.singleCalls).toHaveLength(0);
    // Each combined call covers ALL 4 personas in one round-trip.
    for (const call of tracker.combinedCalls) {
      expect(call.personas).toEqual(PERSONAS);
    }
    // Verdict count = 3 models × 4 personas = 12, same coverage as cross-model.
    expect(result.verdicts).toHaveLength(12);
    expect(result.approvals).toBe(12);
    expect(result.vetoed).toBe(false);
  });

  it('cross-model shape: 12 single judges, 12 round-trips, 12 verdicts', async () => {
    const tracker = makeTracker();
    const panel = buildJudgePanel({
      shape: 'cross-model',
      personas: PERSONAS,
      factories: stubFactories(tracker, 'cross'),
    });

    const result = await panel.review(ARTIFACT);

    expect(tracker.combinedCalls).toHaveLength(0);
    // 4 personas × 3 models = 12 single-shot calls.
    expect(tracker.singleCalls).toHaveLength(12);
    expect(result.verdicts).toHaveLength(12);
    expect(result.approvals).toBe(12);
    expect(result.vetoed).toBe(false);
  });

  it('full shape: base 3 models + extras, all personas × all factories', async () => {
    const tracker = makeTracker();
    const factories = stubFactories(tracker, 'full');
    let extraCalls = 0;
    const extras = [
      (persona: Persona): Judge => ({
        id: `extra:${persona}`,
        persona,
        async review(): Promise<Verdict> {
          extraCalls += 1;
          return { judge: `extra:${persona}`, persona, approved: true, reason: 'extra-ok' };
        },
      }),
    ];
    const panel = buildJudgePanel({
      shape: 'full',
      personas: PERSONAS,
      factories: { ...factories, extras },
    });

    const result = await panel.review(ARTIFACT);

    // 4 personas × (3 base + 1 extra) = 16 single-shot calls.
    expect(tracker.singleCalls).toHaveLength(12);
    expect(extraCalls).toBe(4);
    expect(result.verdicts).toHaveLength(16);
    expect(result.approvals).toBe(16);
  });

  it('compact shape: one combined verdict bundle per call (no per-persona fan-out)', async () => {
    const tracker = makeTracker();
    const panel = buildJudgePanel({
      shape: 'compact',
      personas: PERSONAS,
      factories: stubFactories(tracker, 'verify'),
    });

    await panel.review(ARTIFACT);
    // Critical: each combined model emits EXACTLY 1 round-trip even though
    // it produces 4 verdicts. This is the cost-saving claim made in
    // docs/judge-panel-shapes.md.
    const callsByModel = new Map<string, number>();
    for (const c of tracker.combinedCalls) {
      callsByModel.set(c.id, (callsByModel.get(c.id) ?? 0) + 1);
    }
    expect(callsByModel.get('claude:combined')).toBe(1);
    expect(callsByModel.get('copilot:combined')).toBe(1);
    expect(callsByModel.get('cs:combined')).toBe(1);
  });
});
