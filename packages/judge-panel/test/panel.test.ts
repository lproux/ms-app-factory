import { AppFactoryError, JudgeVetoError } from '@app-factory/shared';
import { describe, expect, it } from 'vitest';
import { JudgePanel } from '../src/panel.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../src/types.js';

function mockJudge(
  id: string,
  persona: Persona,
  verdict: Omit<Verdict, 'judge' | 'persona'> | { throw: Error },
): Judge {
  return {
    id,
    persona,
    async review(): Promise<Verdict> {
      if ('throw' in verdict) throw verdict.throw;
      return { judge: id, persona, ...verdict };
    },
  };
}

const ARTIFACT: JudgeArtifact = {
  kind: 'cs-agent',
  id: 'demo-agent',
  summary: 'A friendly support bot for the docs site.',
};

describe('JudgePanel', () => {
  it('records unavailable judges as synthetic verdicts', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', {
          approved: true,
          score: 0.9,
          reason: 'looks coherent',
        }),
        mockJudge('claude:cost', 'cost', {
          approved: true,
          score: 0.7,
          reason: 'cheap enough',
        }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('UNAVAILABLE', 'direct line is down', { recoverable: true }),
        }),
      ],
      policy: { vetoOn: [], quorum: 2 },
    });

    const result = await panel.review(ARTIFACT);
    expect(result.verdicts).toHaveLength(3);
    const unavailable = result.verdicts.find((v) => v.judge.endsWith(':unavailable'));
    expect(unavailable).toBeDefined();
    expect(unavailable?.persona).toBe('ux');
    expect(unavailable?.reason).toContain('direct line is down');
    expect(result.approvals).toBe(2);
    expect(result.rejections).toBe(0);
    expect(result.vetoed).toBe(false);
  });

  it('rethrows non-recoverable judge errors', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'ok' }),
        mockJudge('claude:security', 'security', {
          throw: new AppFactoryError('FATAL', 'config broken', { recoverable: false }),
        }),
      ],
    });
    await expect(panel.review(ARTIFACT)).rejects.toMatchObject({ code: 'FATAL' });
  });

  it('reviewOrThrow throws JudgeVetoError with dissenting votes', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'good' }),
        mockJudge('claude:security', 'security', {
          approved: false,
          reason: 'plaintext secret in payload',
        }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('CS_JUDGE_NO_SECRET', 'no secret', { recoverable: true }),
        }),
      ],
    });

    await expect(panel.reviewOrThrow(ARTIFACT)).rejects.toBeInstanceOf(JudgeVetoError);
    try {
      await panel.reviewOrThrow(ARTIFACT);
    } catch (err) {
      const v = err as JudgeVetoError;
      const judges = v.votes.map((vote) => vote.judge);
      expect(judges).toContain('claude:security');
      expect(judges.some((j) => j.endsWith(':unavailable'))).toBe(true);
      const security = v.votes.find((vote) => vote.judge === 'claude:security');
      expect(security?.verdict).toBe('reject');
      expect(security?.reason).toContain('plaintext secret');
    }
  });

  it('refuses to construct an empty panel', () => {
    expect(() => new JudgePanel({ judges: [] })).toThrow(/at least one judge/);
  });
});
