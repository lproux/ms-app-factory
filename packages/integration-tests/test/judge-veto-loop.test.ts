import { describe, expect, it } from 'vitest';
import {
  JudgePanel,
  autoImprove,
  type JudgeArtifact,
  type Persona,
} from '@app-factory/judge-panel';
import { createLogger } from '@app-factory/shared';
import {
  makeAlwaysApproveJudge,
  makeKbGroundingRegressionJudge,
} from '../src/mocks/index.js';

const log = createLogger('judge-veto-loop');

const PERSONAS: Persona[] = ['architect', 'security', 'cost', 'ux'];
const REGRESSION_TOKEN = 'KB_UNGROUNDED_FIXTURE_TOKEN_v1';

interface AgentInput {
  instructions: string;
  topicCount: number;
}

function buildArtifact(input: AgentInput, round: number): JudgeArtifact {
  return {
    kind: 'cs-agent',
    id: `veto-loop-fixture-${round}`,
    displayName: 'Veto Loop Fixture',
    summary: [
      `Round: ${round}`,
      `Instructions: ${input.instructions}`,
      `Topics: ${input.topicCount}`,
    ].join('\n'),
    payload: { instructions: input.instructions },
  };
}

describe('Integration — judge veto + auto-improve', () => {
  it('detects the injected KB-grounding regression, runs the auto-improve loop, then clears on the second pass', async () => {
    // Initial input contains the deliberate regression token in agent
    // instructions — exactly the kind of ungrounded reference a KB judge
    // should flag.
    const initialInput: AgentInput = {
      instructions: `You are a helpful assistant. Reference: ${REGRESSION_TOKEN}.`,
      topicCount: 2,
    };

    // Mix one regression-sensitive judge with always-approve judges for the
    // remaining personas, so the veto comes from the architect persona only —
    // mirroring how the real panel might fire.
    const judges = [
      makeKbGroundingRegressionJudge('architect', REGRESSION_TOKEN),
      ...PERSONAS.filter((p) => p !== 'architect').map((p) =>
        makeAlwaysApproveJudge(p, 'fake-other'),
      ),
    ];
    const panel = new JudgePanel({
      judges,
      policy: { tieBreaker: 'architect', vetoOn: ['security'] },
    });

    // The regenerator strips the regression token — mirroring what an
    // auto-improve repair pass would do after reading repairNotes.
    const regenerate = async (
      input: AgentInput,
      repairNotes: string[],
    ): Promise<{ input: AgentInput; artifact: JudgeArtifact }> => {
      log.info({ repairNotes }, 'auto-improve regenerating');
      const cleaned: AgentInput = {
        instructions: input.instructions.replace(REGRESSION_TOKEN, '<grounded>'),
        topicCount: input.topicCount,
      };
      return { input: cleaned, artifact: buildArtifact(cleaned, 2) };
    };

    const result = await autoImprove<AgentInput>({
      panel,
      regenerate,
      initial: { input: initialInput, artifact: buildArtifact(initialInput, 1) },
      maxRounds: 4,
    });

    expect(result.rounds).toBe(2);
    expect(result.input.instructions).not.toContain(REGRESSION_TOKEN);
    expect(result.input.instructions).toContain('<grounded>');
  });

  it('fails clean (JudgeVetoError) when auto-improve hits maxRounds without convergence', async () => {
    const judges = [
      makeKbGroundingRegressionJudge('architect', REGRESSION_TOKEN),
      ...PERSONAS.filter((p) => p !== 'architect').map((p) =>
        makeAlwaysApproveJudge(p, 'fake-other'),
      ),
    ];
    const panel = new JudgePanel({
      judges,
      policy: { tieBreaker: 'architect' },
    });

    // Regenerator that never fixes the regression.
    const regenerate = async (
      input: AgentInput,
    ): Promise<{ input: AgentInput; artifact: JudgeArtifact }> => ({
      input,
      artifact: buildArtifact(input, 99),
    });

    await expect(
      autoImprove<AgentInput>({
        panel,
        regenerate,
        initial: {
          input: { instructions: `bad: ${REGRESSION_TOKEN}`, topicCount: 1 },
          artifact: buildArtifact(
            { instructions: `bad: ${REGRESSION_TOKEN}`, topicCount: 1 },
            1,
          ),
        },
        maxRounds: 2,
      }),
    ).rejects.toMatchObject({ name: 'JudgeVetoError', code: 'JUDGE_VETO' });
  });
});
