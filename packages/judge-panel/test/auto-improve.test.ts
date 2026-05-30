import { JudgeVetoError } from '@app-factory/shared';
import { describe, expect, it } from 'vitest';
import { autoImprove } from '../src/auto-improve.js';
import { JudgePanel } from '../src/panel.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../src/types.js';

interface ScriptedReturn {
  approved: boolean;
  reason?: string;
  repairNotes?: string;
}

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

const INITIAL_ARTIFACT: JudgeArtifact = {
  kind: 'wbs-step',
  id: 'A11',
  summary: 'first draft',
};

describe('autoImprove', () => {
  it('returns once the panel approves; reports the number of rounds taken', async () => {
    const cost = scriptedJudge('copilot:cost', 'cost', [
      { approved: false, repairNotes: 'use cheaper SKU' },
      { approved: false, repairNotes: 'still expensive' },
      { approved: true },
    ]);
    const architect = scriptedJudge('claude:architect', 'architect', [
      { approved: true },
      { approved: true },
      { approved: true },
    ]);
    const panel = new JudgePanel({ judges: [cost, architect], policy: { vetoOn: [] } });

    let regenCalls = 0;
    const result = await autoImprove<{ revision: number }>({
      panel,
      initial: { input: { revision: 0 }, artifact: INITIAL_ARTIFACT },
      async regenerate(input, repairNotes) {
        regenCalls += 1;
        expect(repairNotes.length).toBeGreaterThan(0);
        const nextRevision = input.revision + 1;
        return {
          input: { revision: nextRevision },
          artifact: {
            ...INITIAL_ARTIFACT,
            id: `${INITIAL_ARTIFACT.id}-r${nextRevision}`,
            summary: `revision ${nextRevision}`,
          },
        };
      },
    });

    expect(result.rounds).toBe(3);
    expect(regenCalls).toBe(2);
    expect(result.input.revision).toBe(2);
    expect(result.artifact.id).toBe('A11-r2');
  });

  it('throws JudgeVetoError when maxRounds is reached without convergence', async () => {
    const stubborn = scriptedJudge('claude:security', 'security', [
      { approved: false, reason: 'still leaking secrets', repairNotes: 'redact tokens' },
    ]);
    const panel = new JudgePanel({ judges: [stubborn] });

    let regenCalls = 0;
    await expect(
      autoImprove<number>({
        panel,
        maxRounds: 1,
        initial: { input: 0, artifact: INITIAL_ARTIFACT },
        async regenerate(input) {
          regenCalls += 1;
          return { input: input + 1, artifact: INITIAL_ARTIFACT };
        },
      }),
    ).rejects.toBeInstanceOf(JudgeVetoError);

    expect(regenCalls).toBe(0);
  });
});
