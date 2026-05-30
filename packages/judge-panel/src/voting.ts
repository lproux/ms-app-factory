import type { PanelResult, Persona, Verdict } from './types.js';

const UNAVAILABLE_SUFFIX = ':unavailable';

export interface VotingPolicy {
  quorum?: number;
  vetoOn?: Persona[];
  tieBreaker?: 'majority' | 'architect' | 'unanimous';
}

const DEFAULT_VETO: Persona[] = ['security'];

export function tally(verdicts: Verdict[], policy: VotingPolicy = {}): PanelResult {
  const tieBreaker = policy.tieBreaker ?? 'majority';
  const vetoOn = policy.vetoOn ?? DEFAULT_VETO;

  const counted = verdicts.filter((v) => !isUnavailable(v));
  const unavailableCount = verdicts.length - counted.length;
  const approvals = counted.filter((v) => v.approved).length;
  const rejections = counted.length - approvals;
  const quorum = policy.quorum ?? Math.ceil(verdicts.length / 2);

  const repairNotes = verdicts
    .filter((v) => !v.approved)
    .map((v) => buildRepairNote(v))
    .filter((s): s is string => Boolean(s && s.length > 0));

  if (counted.length < quorum) {
    return {
      vetoed: true,
      verdicts,
      approvals,
      rejections,
      repairNotes: appendQuorumNote(repairNotes, counted.length, quorum, unavailableCount),
    };
  }

  for (const v of counted) {
    if (!v.approved && vetoOn.includes(v.persona)) {
      return { vetoed: true, verdicts, approvals, rejections, repairNotes };
    }
  }

  let vetoed: boolean;
  switch (tieBreaker) {
    case 'unanimous':
      vetoed = rejections > 0;
      break;
    case 'architect': {
      const architect = counted.find((v) => v.persona === 'architect');
      if (architect) {
        vetoed = !architect.approved;
      } else {
        vetoed = decideMajority(approvals, rejections);
      }
      break;
    }
    default:
      vetoed = decideMajority(approvals, rejections);
      break;
  }

  return { vetoed, verdicts, approvals, rejections, repairNotes };
}

function decideMajority(approvals: number, rejections: number): boolean {
  if (approvals > rejections) return false;
  return true;
}

function isUnavailable(v: Verdict): boolean {
  return v.judge.endsWith(UNAVAILABLE_SUFFIX);
}

function buildRepairNote(v: Verdict): string {
  const head = `[${v.judge}/${v.persona}]`;
  const body = v.repairNotes?.trim() || v.reason?.trim() || 'no repair guidance';
  return `${head} ${body}`;
}

function appendQuorumNote(
  notes: string[],
  counted: number,
  quorum: number,
  unavailable: number,
): string[] {
  return [
    ...notes,
    `[panel] quorum not met: ${counted}/${quorum} judges responded (${unavailable} unavailable)`,
  ];
}
