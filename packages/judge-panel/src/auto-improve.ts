import { JudgeVetoError, createLogger } from '@app-factory/shared';
import type { JudgeArtifact } from './types.js';
import type { JudgePanel } from './panel.js';

const log = createLogger('judge-panel:auto-improve');

export interface AutoImproveConfig<I> {
  panel: JudgePanel;
  regenerate: (input: I, repairNotes: string[]) => Promise<{ input: I; artifact: JudgeArtifact }>;
  initial: { input: I; artifact: JudgeArtifact };
  maxRounds?: number;
}

export interface AutoImproveResult<I> {
  input: I;
  artifact: JudgeArtifact;
  rounds: number;
}

export async function autoImprove<I>(cfg: AutoImproveConfig<I>): Promise<AutoImproveResult<I>> {
  let current = cfg.initial;
  let rounds = 0;

  while (true) {
    rounds += 1;
    log.info({ round: rounds, artifact: current.artifact.id }, 'auto-improve: panel review');
    const result = await cfg.panel.review(current.artifact);
    if (!result.vetoed) {
      return { input: current.input, artifact: current.artifact, rounds };
    }
    if (cfg.maxRounds !== undefined && rounds >= cfg.maxRounds) {
      const dissenting = result.verdicts.filter((v) => !v.approved);
      const votes = dissenting.map((v) => ({
        judge: v.judge,
        verdict: v.judge.endsWith(':unavailable') ? 'unavailable' : 'reject',
        reason: v.reason,
      }));
      throw new JudgeVetoError(
        `Auto-improve hit maxRounds=${cfg.maxRounds} without convergence on artifact ${current.artifact.id}`,
        votes,
      );
    }
    log.warn(
      { round: rounds, repairNotes: result.repairNotes.length },
      'auto-improve: vetoed, regenerating',
    );
    current = await cfg.regenerate(current.input, result.repairNotes);
  }
}
