import { AppFactoryError, JudgeVetoError, createLogger } from '@app-factory/shared';
import type { CombinedJudge, Judge, JudgeArtifact, PanelResult, Verdict } from './types.js';
import { tally, type VotingPolicy } from './voting.js';

const log = createLogger('judge-panel:panel');

export interface PanelConfig {
  judges: Judge[];
  /**
   * Optional combined (multi-persona) judges. Each call produces one Verdict
   * per persona the judge declares. Used by the `compact` panel shape.
   */
  combinedJudges?: CombinedJudge[];
  policy?: VotingPolicy;
}

export class JudgePanel {
  private readonly judges: Judge[];
  private readonly combinedJudges: CombinedJudge[];
  private readonly policy?: VotingPolicy;

  constructor(cfg: PanelConfig) {
    const hasSingle = cfg.judges && cfg.judges.length > 0;
    const hasCombined = cfg.combinedJudges && cfg.combinedJudges.length > 0;
    if (!hasSingle && !hasCombined) {
      throw new AppFactoryError('JUDGE_PANEL_EMPTY', 'JudgePanel requires at least one judge');
    }
    this.judges = cfg.judges ?? [];
    this.combinedJudges = cfg.combinedJudges ?? [];
    this.policy = cfg.policy;
  }

  async review(artifact: JudgeArtifact): Promise<PanelResult> {
    const singleSettled = await Promise.allSettled(this.judges.map((j) => j.review(artifact)));
    const singleVerdicts: Verdict[] = singleSettled.map((res, idx) => {
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

    const combinedSettled = await Promise.allSettled(
      this.combinedJudges.map((j) => j.review(artifact)),
    );
    const combinedVerdicts: Verdict[] = combinedSettled.flatMap((res, idx) => {
      const judge = this.combinedJudges[idx];
      if (!judge) {
        throw new AppFactoryError('JUDGE_PANEL_INTERNAL', 'combined judge index out of range');
      }
      if (res.status === 'fulfilled') return res.value;
      const err = res.reason;
      if (err instanceof AppFactoryError && err.recoverable) {
        log.warn(
          { judge: judge.id, personas: judge.personas, code: err.code, reason: err.message },
          'combined judge unavailable; recording synthetic verdicts',
        );
        return judge.personas.map((persona) => ({
          judge: `${judge.id}:unavailable`,
          persona,
          approved: false,
          score: 0,
          reason: err.message,
        }));
      }
      throw err;
    });

    const verdicts: Verdict[] = [...singleVerdicts, ...combinedVerdicts];
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
