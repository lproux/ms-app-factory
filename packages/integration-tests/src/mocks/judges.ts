import type { Judge, JudgeArtifact, Persona, Verdict } from '@app-factory/judge-panel';

/**
 * Build a deterministic always-approve judge for the given persona. The
 * `reason` text is recorded so tests can prove the panel ran.
 */
export function makeAlwaysApproveJudge(persona: Persona, idPrefix = 'fake'): Judge {
  return {
    id: `${idPrefix}:${persona}`,
    persona,
    async review(_artifact: JudgeArtifact): Promise<Verdict> {
      return {
        judge: `${idPrefix}:${persona}`,
        persona,
        approved: true,
        score: 0.95,
        reason: `synthetic ${persona} approval`,
        repairNotes: '',
      };
    },
  };
}

/**
 * Build a judge that rejects when the artifact summary contains
 * `injectedFailureToken`. Used by the veto-loop test.
 */
export function makeKbGroundingRegressionJudge(
  persona: Persona,
  injectedFailureToken: string,
  idPrefix = 'fake-grounded',
): Judge {
  return {
    id: `${idPrefix}:${persona}`,
    persona,
    async review(artifact: JudgeArtifact): Promise<Verdict> {
      const summary = (artifact.summary ?? '') + JSON.stringify(artifact.payload ?? {});
      const stillRegressed = summary.includes(injectedFailureToken);
      return {
        judge: `${idPrefix}:${persona}`,
        persona,
        approved: !stillRegressed,
        score: stillRegressed ? 0.1 : 0.92,
        reason: stillRegressed
          ? `KB grounding regression detected: token "${injectedFailureToken}" still present`
          : 'KB grounding looks clean',
        repairNotes: stillRegressed
          ? `Remove the ungrounded reference "${injectedFailureToken}" from agent instructions`
          : '',
      };
    },
  };
}

/**
 * Build a judge that always returns an unavailable-style error (recoverable).
 */
export function makeFlakyJudge(persona: Persona): Judge {
  return {
    id: `flaky:${persona}`,
    persona,
    async review(_a: JudgeArtifact): Promise<Verdict> {
      return {
        judge: `flaky:${persona}:unavailable`,
        persona,
        approved: false,
        score: 0,
        reason: 'judge transport flaked (synthetic)',
      };
    },
  };
}
