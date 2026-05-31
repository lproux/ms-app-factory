export type Persona = 'architect' | 'security' | 'cost' | 'ux';

export interface JudgeArtifact {
  kind: 'cs-agent' | 'teams-app' | 'wbs-step' | 'plan' | string;
  id: string;
  displayName?: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface Verdict {
  judge: string;
  persona: Persona;
  approved: boolean;
  score?: number;
  reason: string;
  repairNotes?: string;
}

export interface PanelResult {
  vetoed: boolean;
  verdicts: Verdict[];
  approvals: number;
  rejections: number;
  repairNotes: string[];
}

export interface Judge {
  id: string;
  persona: Persona;
  review(artifact: JudgeArtifact): Promise<Verdict>;
}

/**
 * A judge that scores ALL configured personas in a single round-trip and
 * returns one Verdict per persona. Used by the `compact` panel shape to
 * collapse the default 12 single-persona judges down to one call per model.
 */
export interface CombinedJudge {
  id: string;
  personas: Persona[];
  review(artifact: JudgeArtifact): Promise<Verdict[]>;
}
