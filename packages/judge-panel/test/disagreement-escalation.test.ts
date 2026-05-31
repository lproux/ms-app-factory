/**
 * packages/judge-panel/test/disagreement-escalation.test.ts
 *
 * Proves the documented tie-break / escalation path when the panel is
 * split 1 pass / 1 veto / 1 abstain (unavailable). The canonical behaviour
 * is implemented in `packages/judge-panel/src/voting.ts::tally`:
 *
 *   - Unavailable judges are recorded as synthetic verdicts but are EXCLUDED
 *     from the `counted` set used for quorum, tie-break, and approval counts.
 *     They still surface in `verdicts` and a "quorum not met" repair note when
 *     they cause the counted set to fall under quorum.
 *   - A non-approved verdict from a persona in `policy.vetoOn` (default
 *     `['security']`) is a HARD VETO — no tie-break runs.
 *   - Otherwise the configured `tieBreaker` decides:
 *       'majority'    → vetoed when rejections >= approvals (the default)
 *       'architect'   → architect's verdict wins; falls back to majority
 *                       if no architect responded
 *       'unanimous'   → any rejection vetoes
 *
 * In ALL cases the panel returns a definitive PanelResult — it never hangs
 * and never throws on disagreement alone. That's the property under test.
 */

import { AppFactoryError } from '@app-factory/shared';
import { describe, expect, it } from 'vitest';
import { JudgePanel } from '../src/panel.js';
import { tally } from '../src/voting.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../src/types.js';

interface MockSpec {
  approved?: boolean;
  reason?: string;
  repairNotes?: string;
  throw?: Error;
}

function mockJudge(id: string, persona: Persona, spec: MockSpec): Judge {
  return {
    id,
    persona,
    async review(): Promise<Verdict> {
      if (spec.throw) throw spec.throw;
      return {
        judge: id,
        persona,
        approved: spec.approved ?? false,
        reason: spec.reason ?? (spec.approved ? 'ok' : 'reject'),
        repairNotes: spec.repairNotes,
      };
    },
  };
}

const ARTIFACT: JudgeArtifact = {
  kind: 'cs-agent',
  id: 'split-vote-agent',
  summary: 'Agent under contested review; one persona is offline.',
};

describe('JudgePanel disagreement / escalation (1 pass, 1 veto, 1 abstain)', () => {
  it('default policy: majority tie-break sees 1 approve vs 1 reject as a veto, abstain ignored', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'coherent' }),
        // cost is NOT in default vetoOn, so this is a soft rejection that
        // falls through to the tie-breaker.
        mockJudge('copilot:cost', 'cost', { approved: false, reason: 'too pricey' }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('CS_UX_DOWN', 'direct line down', { recoverable: true }),
        }),
      ],
    });

    const result = await panel.review(ARTIFACT);

    // Definitive verdict: the panel returned, did NOT throw, did NOT hang.
    expect(result.verdicts).toHaveLength(3);
    // The abstain shows up as a synthetic ":unavailable" verdict.
    const abstain = result.verdicts.find((v) => v.judge.endsWith(':unavailable'));
    expect(abstain).toBeDefined();
    expect(abstain?.persona).toBe('ux');
    // Counted = 2 (architect + cost). Quorum default = ceil(3/2) = 2. Met.
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(1);
    // Majority tie-breaker: ties go to vetoed.
    expect(result.vetoed).toBe(true);
  });

  it('vetoOn=[security] with the rejecter being security: hard veto, tie-break never runs', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'coherent' }),
        // Security rejection is a HARD veto regardless of tie-breaker config.
        mockJudge('claude:security', 'security', {
          approved: false,
          reason: 'plaintext secret in payload',
        }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('CS_UX_DOWN', 'direct line down', { recoverable: true }),
        }),
      ],
      // Force architect tie-breaker to prove it's bypassed by the hard veto.
      policy: { tieBreaker: 'architect' },
    });

    const result = await panel.review(ARTIFACT);
    expect(result.vetoed).toBe(true);
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(1);
    const security = result.verdicts.find((v) => v.persona === 'security');
    expect(security?.approved).toBe(false);
    expect(security?.reason).toContain('plaintext secret');
  });

  it('architect tie-breaker: architect approves -> panel passes despite a cost veto and a ux abstain', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'coherent' }),
        mockJudge('copilot:cost', 'cost', { approved: false, reason: 'too pricey' }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('CS_UX_DOWN', 'direct line down', { recoverable: true }),
        }),
      ],
      policy: { tieBreaker: 'architect', vetoOn: [] },
    });

    const result = await panel.review(ARTIFACT);
    expect(result.vetoed).toBe(false);
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(1);
  });

  it('architect tie-breaker with no architect responding falls back to majority', () => {
    // Use tally() directly to avoid having to model the "no architect"
    // synthetic-verdict case through the panel; tally is the canonical
    // implementation of the tie-break behaviour.
    const verdicts: Verdict[] = [
      // architect persona is reported, but the verdict is unavailable -> ignored.
      {
        judge: 'claude:architect:unavailable',
        persona: 'architect',
        approved: false,
        reason: 'offline',
      },
      { judge: 'copilot:cost', persona: 'cost', approved: true, reason: 'cheap' },
      { judge: 'cs:ux', persona: 'ux', approved: false, reason: 'awkward' },
    ];
    const result = tally(verdicts, { tieBreaker: 'architect', vetoOn: [], quorum: 2 });
    expect(result.verdicts).toHaveLength(3);
    // counted = [cost (approve), ux (reject)] -> 1/1, majority ties -> vetoed.
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(1);
    expect(result.vetoed).toBe(true);
  });

  it('unanimous policy: any rejection vetoes, abstain is excluded but veto still fires', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'coherent' }),
        mockJudge('copilot:cost', 'cost', { approved: false, reason: 'too pricey' }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('CS_UX_DOWN', 'direct line down', { recoverable: true }),
        }),
      ],
      policy: { tieBreaker: 'unanimous', vetoOn: [] },
    });

    const result = await panel.review(ARTIFACT);
    expect(result.vetoed).toBe(true);
    expect(result.rejections).toBe(1);
  });

  it('quorum not met when abstains drop counted below quorum -> vetoed with quorum repair note', async () => {
    const panel = new JudgePanel({
      judges: [
        mockJudge('claude:architect', 'architect', { approved: true, reason: 'coherent' }),
        mockJudge('copilot:cost', 'cost', {
          throw: new AppFactoryError('COST_DOWN', 'rate-limited', { recoverable: true }),
        }),
        mockJudge('cs:ux', 'ux', {
          throw: new AppFactoryError('UX_DOWN', 'direct line down', { recoverable: true }),
        }),
      ],
      policy: { quorum: 2, vetoOn: [] },
    });

    const result = await panel.review(ARTIFACT);
    expect(result.vetoed).toBe(true);
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(0);
    expect(result.repairNotes.some((n) => n.includes('quorum not met'))).toBe(true);
  });
});
