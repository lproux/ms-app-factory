import { describe, expect, it } from 'vitest';
import { tally } from '../src/voting.js';
import type { Verdict } from '../src/types.js';

function v(
  judge: string,
  persona: Verdict['persona'],
  approved: boolean,
  reason = 'ok',
): Verdict {
  return { judge, persona, approved, reason };
}

describe('tally', () => {
  it('does not veto when all judges approve', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('claude:security', 'security', true),
      v('claude:cost', 'cost', true),
    ];
    const result = tally(verdicts);
    expect(result.vetoed).toBe(false);
    expect(result.approvals).toBe(3);
    expect(result.rejections).toBe(0);
    expect(result.repairNotes).toEqual([]);
  });

  it('vetoes on a security rejection even with majority approvals', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('claude:cost', 'cost', true),
      v('claude:ux', 'ux', true),
      v('claude:security', 'security', false, 'leaks token in logs'),
    ];
    const result = tally(verdicts);
    expect(result.vetoed).toBe(true);
    expect(result.approvals).toBe(3);
    expect(result.rejections).toBe(1);
    expect(result.repairNotes[0]).toContain('claude:security');
    expect(result.repairNotes[0]).toContain('leaks token in logs');
  });

  it('vetoes when majority policy ties', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('claude:cost', 'cost', false, 'too expensive'),
    ];
    const result = tally(verdicts, { vetoOn: [] });
    expect(result.vetoed).toBe(true);
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(1);
  });

  it('excludes unavailable verdicts from counts but keeps them in the list', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('claude:cost', 'cost', true),
      v('cs:ux:unavailable', 'ux', false, 'direct line down'),
    ];
    const result = tally(verdicts, { vetoOn: [], quorum: 2 });
    expect(result.vetoed).toBe(false);
    expect(result.approvals).toBe(2);
    expect(result.rejections).toBe(0);
    expect(result.verdicts).toHaveLength(3);
  });

  it('respects an explicit quorum that exceeds the responding judges', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('cs:security:unavailable', 'security', false, 'down'),
      v('copilot:cost:unavailable', 'cost', false, 'down'),
    ];
    const result = tally(verdicts, { quorum: 2 });
    expect(result.vetoed).toBe(true);
    expect(result.approvals).toBe(1);
    expect(result.rejections).toBe(0);
    expect(result.repairNotes.some((n) => n.includes('quorum not met'))).toBe(true);
  });

  it('uses architect tie-breaker when configured', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('copilot:cost', 'cost', false, 'pricey'),
    ];
    const result = tally(verdicts, { vetoOn: [], tieBreaker: 'architect' });
    expect(result.vetoed).toBe(false);
  });

  it('vetoes under unanimous policy with any rejection', () => {
    const verdicts: Verdict[] = [
      v('claude:architect', 'architect', true),
      v('claude:cost', 'cost', true),
      v('claude:ux', 'ux', false, 'awkward'),
    ];
    const result = tally(verdicts, { vetoOn: [], tieBreaker: 'unanimous' });
    expect(result.vetoed).toBe(true);
  });
});
