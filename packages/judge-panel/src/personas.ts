import type { JudgeArtifact, Persona, Verdict } from './types.js';

const RESPONSE_CONTRACT = `Respond with STRICT JSON only, matching this schema exactly and nothing else:
{"approved": boolean, "score": number (0..1), "reason": string, "repairNotes": string}
Do not wrap the JSON in markdown fences. Do not add any commentary before or after.`;

const COMBINED_RESPONSE_CONTRACT = `Respond with STRICT JSON only, matching this schema exactly and nothing else:
{"verdicts": {"architect": {...}, "security": {...}, "cost": {...}, "ux": {...}}}
Each inner object must follow:
{"approved": boolean, "score": number (0..1), "reason": string, "repairNotes": string}
Only include the personas listed in this prompt. Do not wrap the JSON in markdown fences.`;

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
  return verdictFromJson(json, judgeId, persona);
}

/**
 * Build a single prompt that asks one judge to score the artifact from the
 * point of view of EVERY supplied persona, in one round-trip. Used by the
 * `compact` judge-panel shape to cut LLM calls from 12 to 3.
 */
export function buildCombinedPrompt(personas: Persona[], artifact: JudgeArtifact): string {
  if (personas.length === 0) {
    throw new Error('buildCombinedPrompt requires at least one persona');
  }
  const briefs = personas
    .map((p) => `### ${p.toUpperCase()} brief\n${PERSONA_BRIEFS[p]}`)
    .join('\n\n');
  const payloadBlock =
    artifact.payload && Object.keys(artifact.payload).length > 0
      ? `\n\nRaw payload (JSON):\n${safeStringify(artifact.payload)}`
      : '';
  const displayLine = artifact.displayName ? `\nDisplay name: ${artifact.displayName}` : '';
  return [
    'You are a COMBINED multi-persona judge. Score the artifact below from each of the following personas independently:',
    personas.map((p) => `- ${p}`).join('\n'),
    '',
    briefs,
    '',
    `Artifact under review:`,
    `- kind: ${artifact.kind}`,
    `- id: ${artifact.id}${displayLine}`,
    '',
    `Summary the team wrote about this artifact:`,
    artifact.summary,
    payloadBlock,
    '',
    COMBINED_RESPONSE_CONTRACT,
  ].join('\n');
}

/**
 * Parse a combined-judge response that contains a `verdicts` map keyed by
 * persona. Returns one Verdict per persona requested. Missing personas
 * become recoverable rejections with `reason: 'no verdict in combined response'`.
 */
export function parseCombinedVerdicts(
  raw: string,
  judgeId: string,
  personas: Persona[],
): Verdict[] {
  const json = extractJson(raw);
  const inner =
    json && typeof json === 'object' && 'verdicts' in json && typeof json.verdicts === 'object'
      ? (json.verdicts as Record<string, unknown>)
      : (json as Record<string, unknown>);
  return personas.map((persona) => {
    const slot = inner?.[persona];
    if (slot && typeof slot === 'object') {
      return verdictFromJson(slot as Record<string, unknown>, judgeId, persona);
    }
    return {
      judge: judgeId,
      persona,
      approved: false,
      reason: 'no verdict in combined response',
    };
  });
}

function verdictFromJson(
  json: Record<string, unknown>,
  judgeId: string,
  persona: Persona,
): Verdict {
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
