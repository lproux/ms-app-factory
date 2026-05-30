import type { JudgeArtifact, Persona, Verdict } from './types.js';

const RESPONSE_CONTRACT = `Respond with STRICT JSON only, matching this schema exactly and nothing else:
{"approved": boolean, "score": number (0..1), "reason": string, "repairNotes": string}
Do not wrap the JSON in markdown fences. Do not add any commentary before or after.`;

const PERSONA_BRIEFS: Record<Persona, string> = {
  architect:
    'You are the ARCHITECT judge. Evaluate technical coherence, sound design, dependency hygiene, ' +
    'separation of concerns, error handling, and whether the artifact achieves its stated purpose ' +
    'in an idiomatic, maintainable way. Reject if it is incoherent, missing critical components, ' +
    'or built on the wrong primitives.',
  security:
    'You are the SECURITY judge. Evaluate authentication, authorization, secret handling, ' +
    'prompt-injection resistance, least-privilege scopes, data-exfiltration risk, and audit trail. ' +
    'Reject on any meaningful security risk; a security rejection is a hard veto for the panel.',
  cost:
    'You are the COST judge. Evaluate resource sizing, SKU choices, region selection, ' +
    'idle-cost exposure, autoscale shape, and whether cheaper-equivalent options were missed. ' +
    'Reject if the artifact provisions wastefully or has unbounded cost vectors.',
  ux:
    'You are the UX judge. Evaluate user-facing clarity: greetings, error messages, conversational ' +
    'flow, accessibility, brand consistency, and whether the artifact is delightful and unsurprising ' +
    'to the target audience. Reject on confusing or hostile UX.',
};

export function buildPrompt(persona: Persona, artifact: JudgeArtifact): string {
  const brief = PERSONA_BRIEFS[persona];
  const payloadBlock =
    artifact.payload && Object.keys(artifact.payload).length > 0
      ? `\n\nRaw payload (JSON):\n${safeStringify(artifact.payload)}`
      : '';
  const displayLine = artifact.displayName ? `\nDisplay name: ${artifact.displayName}` : '';
  return [
    brief,
    '',
    `Artifact under review:`,
    `- kind: ${artifact.kind}`,
    `- id: ${artifact.id}${displayLine}`,
    '',
    `Summary the team wrote about this artifact:`,
    artifact.summary,
    payloadBlock,
    '',
    RESPONSE_CONTRACT,
  ].join('\n');
}

export function parseVerdict(
  raw: string,
  judgeId: string,
  persona: Persona,
): Omit<Verdict, 'judge' | 'persona'> & { judge: string; persona: Persona } {
  const json = extractJson(raw);
  const approved = typeof json.approved === 'boolean' ? json.approved : false;
  const score =
    typeof json.score === 'number' && Number.isFinite(json.score)
      ? Math.min(1, Math.max(0, json.score))
      : undefined;
  const reason = typeof json.reason === 'string' ? json.reason : 'no reason provided';
  const repairNotes = typeof json.repairNotes === 'string' ? json.repairNotes : undefined;
  return { judge: judgeId, persona, approved, score, reason, repairNotes };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? sliceFirstObject(trimmed) ?? trimmed;
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return {};
}

function sliceFirstObject(s: string): string | undefined {
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return undefined;
}
