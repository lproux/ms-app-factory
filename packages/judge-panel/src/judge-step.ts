/**
 * packages/judge-panel/src/judge-step.ts
 *
 * Shared judge-panel "step" wrapper used by the A11 (Copilot Studio) and
 * B13 (Teams app) WBS stages. Both stages used to inline the same
 * `buildJudgePanel` + `autoImprove` + `panel.review` + `JudgeVetoError`
 * handling block, differing only in artifact builder + ctx shape. The
 * critic flagged this as a 65-line duplication and noted that the
 * synthetic veto verdict was hard-coding `persona: 'architect'`, which
 * hides the real persona that vetoed the artifact.
 *
 * `runJudgePanelStep` extracts that block. Crucially, on `JudgeVetoError`
 * after auto-improve exhaustion it preserves the **real** persona by
 * decoding the canonical judge id format `model:persona` (see
 * `packages/judge-panel/src/judges/*.ts` — every single-persona judge
 * registers as e.g. `claude:architect`, `copilot:security`, `cs:cost`).
 * Combined judges use `model:combined` and lose persona context once
 * `JudgePanel.reviewOrThrow` collapses verdicts to votes, so we fall back
 * to `'architect'` for those entries (matching the legacy behaviour).
 */

import {
  AppFactoryError,
  JudgeVetoError,
  createLogger,
  type FactoryContext,
} from '@app-factory/shared';
import { autoImprove } from './auto-improve.js';
import { buildJudgePanel } from './build-panel.js';
import type { JudgeArtifact, PanelResult, Persona, Verdict } from './types.js';

const log = createLogger('judge-panel:judge-step');

const PERSONA_VALUES: ReadonlyArray<Persona> = ['architect', 'security', 'cost', 'ux'];
const DEFAULT_PERSONAS: ReadonlyArray<Persona> = ['architect', 'security', 'cost', 'ux'];

export interface JudgeStepArgs<C> {
  /** WBS-step context that owns the accumulator (`warnings`, etc.). */
  ctx: C & { fctx: FactoryContext; warnings: string[] };
  /** Artifact kind tag echoed into log lines (e.g. `'A11'`, `'B13'`). */
  kind: string;
  /**
   * Build the JudgeArtifact for a given set of repair notes. The first
   * call passes `[]`; subsequent auto-improve rounds pass the panel's
   * `repairNotes`. Implementations typically embed the notes into the
   * artifact summary so judges can react.
   */
  buildArtifact: (extraNotes: string[]) => JudgeArtifact;
  /**
   * Optional override of the persona roster. Defaults to the canonical
   * `['architect','security','cost','ux']` set used by A11/B13.
   */
  personas?: Persona[];
  /**
   * Optional maxRounds override. Defaults to `ctx.fctx.judge.maxRounds`.
   */
  maxRounds?: number;
}

export interface JudgeStepResult {
  panel: PanelResult;
}

/**
 * Drive the judge panel for a WBS step. Behaviour mirrors the legacy
 * A11/B13 blocks exactly:
 *
 *   - happy path: `panel.review(converged.artifact)` is re-run to capture
 *     the passing `PanelResult` (so callers can attach it to ctx).
 *   - veto path: returns a synthetic vetoed `PanelResult` whose
 *     verdicts preserve the real persona from `votes[i].judge`.
 *   - panel internal error: pushes a warning and returns a synthetic
 *     non-vetoed empty PanelResult so the WBS keeps going.
 */
export async function runJudgePanelStep<C>(
  args: JudgeStepArgs<C>,
): Promise<JudgeStepResult> {
  const { ctx, kind, buildArtifact } = args;
  const personas = args.personas ?? [...DEFAULT_PERSONAS];
  const maxRounds = args.maxRounds ?? ctx.fctx.judge.maxRounds;

  if (personas.length === 0) {
    throw new AppFactoryError(
      'JUDGE_STEP_PERSONAS_EMPTY',
      `runJudgePanelStep requires at least one persona (${kind})`,
    );
  }

  const panel = buildJudgePanel({
    shape: ctx.fctx.judge.shape,
    personas,
    policy: { vetoOn: ['security'] },
  });

  try {
    const converged = await autoImprove({
      panel,
      initial: { input: ctx, artifact: buildArtifact([]) },
      maxRounds,
      regenerate: async (input, repairNotes) => {
        input.warnings.push(`${kind} auto-improve repair notes: ${repairNotes.join(' | ')}`);
        return { input, artifact: buildArtifact(repairNotes) };
      },
    });
    const reRun = await panel.review(converged.artifact);
    log.info({ kind, rounds: converged.rounds }, 'judge panel auto-improve converged');
    return { panel: reRun };
  } catch (err) {
    if (err instanceof JudgeVetoError) {
      ctx.warnings.push(`${kind} judge veto after auto-improve: ${err.message}`);
      const verdicts: Verdict[] = err.votes.map((v) => ({
        judge: v.judge,
        persona: personaFromJudgeId(v.judge),
        approved: false,
        reason: v.reason,
      }));
      const synthetic: PanelResult = {
        vetoed: true,
        approvals: 0,
        rejections: err.votes.length,
        verdicts,
        repairNotes: err.votes.map((v) => v.reason),
      };
      return { panel: synthetic };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.warnings.push(`${kind} judge panel error: ${message}`);
    return {
      panel: { vetoed: false, verdicts: [], approvals: 0, rejections: 0, repairNotes: [] },
    };
  }
}

/**
 * Decode the persona slot from a judge id. Canonical single-persona
 * judges register as `${model}:${persona}` (e.g. `claude:architect`).
 * Unavailable judges suffix `:unavailable` (e.g. `claude:architect:unavailable`).
 * Combined judges use `${model}:combined` and carry no persona in the
 * id; for those we fall back to `'architect'` (the legacy hard-coded
 * default, kept for backwards compatibility on the veto-collapse path).
 */
export function personaFromJudgeId(judgeId: string): Persona {
  const parts = judgeId.split(':');
  const slot = parts[1];
  if (slot && (PERSONA_VALUES as ReadonlyArray<string>).includes(slot)) {
    return slot as Persona;
  }
  return 'architect';
}
