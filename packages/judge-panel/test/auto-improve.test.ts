/**
 * packages/judge-panel/test/auto-improve.test.ts
 *
 * Verifies the "judge-panel veto + auto-improve loop" scenario from the
 * App Factory plan (see Phase-3 verification #4):
 *
 *   "Inject a deliberate KB-grounding regression; verify the panel catches
 *    it, the auto-improve loop produces a fix, and the second pass clears."
 *
 * F5 reported that the default A11/B13 WBS steps call `panel.review` once
 * and store the result — they do NOT wire `autoImprove` in. This test
 * therefore exercises `autoImprove` (the exported function from
 * `packages/judge-panel/src/auto-improve.ts`) DIRECTLY against three
 * deterministic in-process judges. No network.
 */

import { JudgeVetoError } from '@app-factory/shared';
import { describe, expect, it } from 'vitest';
import { autoImprove } from '../src/auto-improve.js';
import { JudgePanel } from '../src/panel.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../src/types.js';
import {
  buildBrokenFixture,
  buildRepairedFixture,
  type SeedAgentArtifact,
} from '../../../tools/seed-veto-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ScriptedReturn {
  approved: boolean;
  reason?: string;
  repairNotes?: string;
}

/** Judge that returns a pre-scripted sequence of verdicts, one per review(). */
function scriptedJudge(id: string, persona: Persona, script: ScriptedReturn[]): Judge {
  let call = 0;
  return {
    id,
    persona,
    async review(): Promise<Verdict> {
      const step = script[Math.min(call, script.length - 1)];
      call += 1;
      if (!step) {
        throw new Error(`scripted judge ${id} ran out of script entries`);
      }
      return {
        judge: id,
        persona,
        approved: step.approved,
        reason: step.reason ?? (step.approved ? 'ok' : 'needs work'),
        repairNotes: step.repairNotes,
      };
    },
  };
}

/**
 * A judge that inspects the artifact's `payload.generativeAnswers.sources`
 * and vetoes when the array is empty. This is the "kb-grounding" rule we
 * want the panel to enforce on a real CS agent artifact.
 */
function kbGroundingJudge(id: string, persona: Persona): Judge {
  return {
    id,
    persona,
    async review(artifact: JudgeArtifact): Promise<Verdict> {
      const ga = (artifact.payload as { generativeAnswers?: { sources?: unknown[] } } | undefined)
        ?.generativeAnswers;
      const sources = Array.isArray(ga?.sources) ? ga.sources : [];
      if (sources.length === 0) {
        return {
          judge: id,
          persona,
          approved: false,
          reason: 'veto: kb-grounding — generativeAnswers.sources is empty',
          repairNotes:
            'Wire generativeAnswers.sources from kbSources before publishing (WBS-A5/A6).',
        };
      }
      return {
        judge: id,
        persona,
        approved: true,
        score: 0.9,
        reason: `kb-grounding ok: ${sources.length} source(s) wired`,
      };
    },
  };
}

/** Cost judge that always approves cs-agent artifacts (no expensive SKUs here). */
function permissiveCostJudge(id: string): Judge {
  return {
    id,
    persona: 'cost',
    async review(): Promise<Verdict> {
      return { judge: id, persona: 'cost', approved: true, score: 0.85, reason: 'within budget' };
    },
  };
}

/** Architect judge that approves any cs-agent with at least one topic. */
function architectJudge(id: string): Judge {
  return {
    id,
    persona: 'architect',
    async review(artifact: JudgeArtifact): Promise<Verdict> {
      const topics = (artifact.payload as { topics?: unknown[] } | undefined)?.topics ?? [];
      if (!Array.isArray(topics) || topics.length === 0) {
        return {
          judge: id,
          persona: 'architect',
          approved: false,
          reason: 'no topics defined',
          repairNotes: 'Add at least a Greeting and Fallback topic.',
        };
      }
      return {
        judge: id,
        persona: 'architect',
        approved: true,
        score: 0.92,
        reason: 'topics + instructions look coherent',
      };
    },
  };
}

/** Convert a SeedAgentArtifact (rich JSON) to the JudgeArtifact contract. */
function toJudgeArtifact(seed: SeedAgentArtifact): JudgeArtifact {
  return {
    kind: seed.kind,
    id: seed.id,
    displayName: seed.displayName,
    summary: seed.summary,
    payload: seed.payload as unknown as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('judge-panel veto + autoImprove loop (kb-grounding regression)', () => {
  it('vetoes a CS agent with empty generativeAnswers.sources via a "veto: kb-grounding" vote', async () => {
    const panel = new JudgePanel({
      judges: [
        architectJudge('claude:architect'),
        // Security persona enforces the KB-grounding contract: an ungrounded
        // bot can hallucinate, which is a hard veto under the panel policy.
        kbGroundingJudge('cs:security', 'security'),
        permissiveCostJudge('copilot:cost'),
      ],
    });

    const brokenArtifact = toJudgeArtifact(buildBrokenFixture());
    const result = await panel.review(brokenArtifact);

    expect(result.vetoed).toBe(true);
    expect(result.verdicts).toHaveLength(3);
    const vetoVote = result.verdicts.find((v) => v.reason.includes('veto: kb-grounding'));
    expect(vetoVote).toBeDefined();
    expect(vetoVote?.approved).toBe(false);
    expect(vetoVote?.persona).toBe('security');
    expect(result.repairNotes.some((n) => /kb-?grounding|kbSources|generativeAnswers/i.test(n))).toBe(
      true,
    );
  });

  it('autoImprove repairs the artifact and the second panel pass clears', async () => {
    const panel = new JudgePanel({
      judges: [
        architectJudge('claude:architect'),
        kbGroundingJudge('cs:security', 'security'),
        permissiveCostJudge('copilot:cost'),
      ],
    });

    const brokenArtifact = toJudgeArtifact(buildBrokenFixture());

    let regenCalls = 0;
    const repairedFixture = buildRepairedFixture();
    const repairedSources = repairedFixture.payload.generativeAnswers.sources;

    const result = await autoImprove<SeedAgentArtifact>({
      panel,
      initial: { input: buildBrokenFixture(), artifact: brokenArtifact },
      async regenerate(input, repairNotes) {
        regenCalls += 1;
        // The auto-improve loop must hand us the panel's repairNotes so the
        // regenerator knows WHAT to fix. Assert the kb-grounding note made it.
        expect(repairNotes.some((n) => /kb-?grounding|kbSources/i.test(n))).toBe(true);
        const fixed: SeedAgentArtifact = {
          ...input,
          id: `${input.id}:auto-improved`,
          payload: {
            ...input.payload,
            generativeAnswers: {
              enabled: true,
              sources: repairedSources,
            },
          },
        };
        return { input: fixed, artifact: toJudgeArtifact(fixed) };
      },
    });

    expect(regenCalls).toBe(1);
    expect(result.rounds).toBe(2);
    // The repaired artifact has non-empty sources.
    const finalSources = (
      result.artifact.payload as { generativeAnswers?: { sources?: unknown[] } } | undefined
    )?.generativeAnswers?.sources;
    expect(Array.isArray(finalSources)).toBe(true);
    expect((finalSources as unknown[]).length).toBeGreaterThan(0);
    expect(finalSources).toEqual(repairedSources);

    // Re-run the panel directly on the repaired artifact and assert pass.
    const reRun = await panel.review(result.artifact);
    expect(reRun.vetoed).toBe(false);
    expect(reRun.rejections).toBe(0);
    expect(reRun.approvals).toBe(3);
  });

  it('throws JudgeVetoError when maxRounds is reached without convergence', async () => {
    // Regression coverage from the previous spec: the loop must not run
    // forever; maxRounds=1 + a judge that always rejects must throw.
    const stubborn = scriptedJudge('claude:security', 'security', [
      { approved: false, reason: 'still leaking secrets', repairNotes: 'redact tokens' },
    ]);
    const panel = new JudgePanel({ judges: [stubborn] });

    let regenCalls = 0;
    await expect(
      autoImprove<number>({
        panel,
        maxRounds: 1,
        initial: {
          input: 0,
          artifact: { kind: 'wbs-step', id: 'A11', summary: 'first draft' },
        },
        async regenerate(input) {
          regenCalls += 1;
          return {
            input: input + 1,
            artifact: { kind: 'wbs-step', id: 'A11', summary: 'first draft' },
          };
        },
      }),
    ).rejects.toBeInstanceOf(JudgeVetoError);

    // maxRounds=1 means the first failing review aborts BEFORE regenerate runs.
    expect(regenCalls).toBe(0);
  });

  it('maxRounds=1 short-circuits after exactly one panel.review call', async () => {
    // Mirrors the FactoryContext.judge.maxRounds=1 fast-path: routine runs
    // should bail out immediately on veto instead of paying for 3 rounds.
    let panelReviewCalls = 0;
    const countingJudge: Judge = {
      id: 'claude:security',
      persona: 'security',
      async review(): Promise<Verdict> {
        panelReviewCalls += 1;
        return {
          judge: 'claude:security',
          persona: 'security',
          approved: false,
          reason: 'fast-fail',
          repairNotes: 'remove secret',
        };
      },
    };
    const panel = new JudgePanel({ judges: [countingJudge] });

    let regenCalls = 0;
    await expect(
      autoImprove<number>({
        panel,
        maxRounds: 1,
        initial: { input: 0, artifact: { kind: 'wbs-step', id: 'short', summary: 'short-circuit' } },
        async regenerate(input) {
          regenCalls += 1;
          return {
            input: input + 1,
            artifact: { kind: 'wbs-step', id: 'short', summary: 'should not reach' },
          };
        },
      }),
    ).rejects.toBeInstanceOf(JudgeVetoError);

    expect(panelReviewCalls).toBe(1);
    expect(regenCalls).toBe(0);
  });
});
