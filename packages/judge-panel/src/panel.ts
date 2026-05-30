import { AppFactoryError, JudgeVetoError, createLogger } from '@app-factory/shared';
import type { Judge, JudgeArtifact, PanelResult, Verdict } from './types.js';
import { tally, type VotingPolicy } from './voting.js';

const log = createLogger('judge-panel:panel');

export interface PanelConfig {
  judges: Judge[];
  policy?: VotingPolicy;
}

export class JudgePanel {
  private readonly judges: Judge[];
  private readonly policy?: VotingPolicy;

  constructor(cfg: PanelConfig) {
    if (!cfg.judges || cfg.judges.length === 0) {
      throw new AppFactoryError('JUDGE_PANEL_EMPTY', 'JudgePanel requires at least one judge');
    }
    this.judges = cfg.judges;
    this.policy = cfg.policy;
  }

  async review(artifact: JudgeArtifact): Promise<PanelResult> {
    const settled = await Promise.allSettled(this.judges.map((j) => j.review(artifact)));
    const verdicts: Verdict[] = settled.map((res, idx) => {
      const judge = this.judges[idx];
      if (!judge) {
        throw new AppFactoryError('JUDGE_PANEL_INTERNAL', 'judge index out of range');
      }
      if (res.status === 'fulfilled') return res.value;
      const err = res.reason;
      if (err instanceof AppFactoryError && err.recoverable) {
        log.warn(
          { judge: judge.id, persona: judge.persona, code: err.code, reason: err.message },
          'judge unavailable; recording synthetic verdict',
        );
        return {
          judge: `${judge.id}:unavailable`,
          persona: judge.persona,
          approved: false,
          score: 0,
          reason: err.message,
        };
      }
      throw err;
    });
    const result = tally(verdicts, this.policy);
    log.info(
      {
        artifact: artifact.id,
        vetoed: result.vetoed,
        approvals: result.approvals,
        rejections: result.rejections,
      },
      'panel review complete',
    );
    return result;
  }

  async reviewOrThrow(artifact: JudgeArtifact): Promise<PanelResult> {
    const result = await this.review(artifact);
    if (result.vetoed) {
      const dissenting = result.verdicts.filter((v) => !v.approved);
      const votes = dissenting.map((v) => ({
        judge: v.judge,
        verdict: v.judge.endsWith(':unavailable') ? 'unavailable' : 'reject',
        reason: v.reason,
      }));
      throw new JudgeVetoError(
        `Judge panel vetoed artifact ${artifact.id} (${dissenting.length} dissenting / ${result.approvals} approving)`,
        votes,
      );
    }
    return result;
  }
}
