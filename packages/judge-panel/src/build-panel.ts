/**
 * `buildJudgePanel` — translate a fleet-wide judge-panel shape into a
 * configured `JudgePanel`. The three shapes trade off coverage against
 * LLM-call budget:
 *
 *   compact     → 3 calls  (one combined judge per model, all personas in one prompt)
 *   cross-model → 12 calls (every persona × every model — historical default)
 *   full        → N×M+     (every persona × every registered factory; extensible)
 *
 * Callers pass the persona roster and (optionally) override the judge
 * factories so this helper stays unit-testable without network. The default
 * factories wire up the three production judges (`claude`, `gh-copilot`,
 * `copilot-studio`).
 */

import { createLogger, type JudgePanelShape } from '@app-factory/shared';
import {
  makeClaudeCombinedJudge,
  makeClaudeJudge,
  type ClaudeCombinedJudgeOptions,
  type ClaudeJudgeOptions,
} from './judges/claude.js';
import {
  makeCopilotStudioCombinedJudge,
  makeCopilotStudioJudge,
  type CopilotStudioCombinedJudgeOptions,
  type CopilotStudioJudgeOptions,
} from './judges/copilot-studio.js';
import {
  makeGhCopilotCombinedJudge,
  makeGhCopilotJudge,
  type GhCopilotCombinedJudgeOptions,
  type GhCopilotJudgeOptions,
} from './judges/copilot.js';
import { JudgePanel } from './panel.js';
import type { CombinedJudge, Judge, Persona } from './types.js';
import type { VotingPolicy } from './voting.js';

const log = createLogger('judge-panel:build');

export interface JudgePanelFactories {
  /** Build a single-persona judge for the given model. */
  claude?: (opts: ClaudeJudgeOptions) => Judge;
  copilot?: (opts: GhCopilotJudgeOptions) => Judge;
  copilotStudio?: (opts: CopilotStudioJudgeOptions) => Judge;
  /** Build a combined (multi-persona) judge for the given model. */
  claudeCombined?: (opts: ClaudeCombinedJudgeOptions) => CombinedJudge;
  copilotCombined?: (opts: GhCopilotCombinedJudgeOptions) => CombinedJudge;
  copilotStudioCombined?: (opts: CopilotStudioCombinedJudgeOptions) => CombinedJudge;
  /**
   * Additional persona-keyed judge factories. Each entry contributes ONE
   * extra Judge per persona under the `full` shape; ignored by `compact`
   * and `cross-model`.
   */
  extras?: Array<(persona: Persona) => Judge>;
}

export interface BuildJudgePanelOptions {
  shape: JudgePanelShape;
  personas: Persona[];
  policy?: VotingPolicy;
  factories?: JudgePanelFactories;
}

const DEFAULT_FACTORIES: Required<Omit<JudgePanelFactories, 'extras'>> & { extras: NonNullable<JudgePanelFactories['extras']> } = {
  claude: makeClaudeJudge,
  copilot: makeGhCopilotJudge,
  copilotStudio: makeCopilotStudioJudge,
  claudeCombined: makeClaudeCombinedJudge,
  copilotCombined: makeGhCopilotCombinedJudge,
  copilotStudioCombined: makeCopilotStudioCombinedJudge,
  extras: [],
};

/**
 * Construct a `JudgePanel` for the requested shape. Returns a ready-to-use
 * panel; callers still own the auto-improve loop and the `maxRounds` budget
 * (see `FactoryContext.judge.maxRounds`).
 */
export function buildJudgePanel(opts: BuildJudgePanelOptions): JudgePanel {
  const { shape, personas } = opts;
  if (personas.length === 0) {
    throw new Error('buildJudgePanel requires at least one persona');
  }
  const f = { ...DEFAULT_FACTORIES, ...(opts.factories ?? {}) };
  const policy: VotingPolicy = opts.policy ?? { vetoOn: ['security'] };

  switch (shape) {
    case 'compact': {
      const combinedJudges: CombinedJudge[] = [
        f.claudeCombined({ personas }),
        f.copilotCombined({ personas }),
        f.copilotStudioCombined({ personas }),
      ];
      log.info(
        { shape, personas, judgeCount: combinedJudges.length },
        'built compact judge panel',
      );
      return new JudgePanel({ judges: [], combinedJudges, policy });
    }
    case 'cross-model': {
      const judges: Judge[] = personas.flatMap((persona) => [
        f.claude({ persona }),
        f.copilot({ persona }),
        f.copilotStudio({ persona }),
      ]);
      log.info({ shape, personas, judgeCount: judges.length }, 'built cross-model judge panel');
      return new JudgePanel({ judges, policy });
    }
    case 'full': {
      const baseFactories: Array<(persona: Persona) => Judge> = [
        (p) => f.claude({ persona: p }),
        (p) => f.copilot({ persona: p }),
        (p) => f.copilotStudio({ persona: p }),
        ...f.extras,
      ];
      const judges: Judge[] = personas.flatMap((persona) =>
        baseFactories.map((make) => make(persona)),
      );
      log.info({ shape, personas, judgeCount: judges.length }, 'built full judge panel');
      return new JudgePanel({ judges, policy });
    }
    default: {
      const exhaustive: never = shape;
      throw new Error(`unknown judge-panel shape: ${exhaustive as string}`);
    }
  }
}
