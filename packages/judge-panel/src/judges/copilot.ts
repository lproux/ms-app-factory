import { AppFactoryError, createLogger } from '@app-factory/shared';
import { spawn, type WorkerHandle } from '@app-factory/orchestrator';
import { buildPrompt, parseVerdict } from '../personas.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../types.js';

const log = createLogger('judge-panel:gh-copilot');

const READY_PATTERN = /(^|\n)\$\s*$|gh copilot:/i;

export interface GhCopilotJudgeOptions {
  persona: Persona;
  ghBin?: string;
  session?: string;
}

export function makeGhCopilotJudge(opts: GhCopilotJudgeOptions): Judge {
  const persona = opts.persona;
  const ghBin = opts.ghBin ?? 'gh';
  const id = `copilot:${persona}`;

  return {
    id,
    persona,
    async review(artifact: JudgeArtifact): Promise<Verdict> {
      let worker: WorkerHandle | undefined;
      try {
        worker = await spawn(`${ghBin} --version`, {
          name: `judge-${persona}`,
          session: opts.session,
        });
        try {
          await worker.waitFor(/gh version|GH_COPILOT|\$\s*$/i, {
            timeoutMs: 8_000,
            pollMs: 500,
          });
        } catch (err) {
          throw new AppFactoryError(
            'GH_COPILOT_UNAVAILABLE',
            `gh CLI not responsive: ${(err as Error).message}`,
            { recoverable: true, cause: err, details: { judge: id } },
          );
        }

        const prompt = buildPrompt(persona, artifact);
        const heredoc = buildHeredoc(prompt);
        log.debug({ judge: id, artifact: artifact.id }, 'submitting to gh copilot');
        await worker.send(`${ghBin} copilot suggest -t shell <<'AF_JUDGE_EOF'\n${heredoc}\nAF_JUDGE_EOF`);

        let captured: string;
        try {
          captured = await worker.waitFor(READY_PATTERN, { timeoutMs: 60_000, pollMs: 1_000 });
        } catch (err) {
          throw new AppFactoryError(
            'GH_COPILOT_TIMEOUT',
            `gh copilot did not produce a verdict in time: ${(err as Error).message}`,
            { recoverable: true, cause: err, details: { judge: id } },
          );
        }

        const tailWindow = captured.split('AF_JUDGE_EOF').pop() ?? captured;
        return parseVerdict(tailWindow, id, persona);
      } finally {
        if (worker) {
          try {
            await worker.kill();
          } catch (err) {
            log.warn({ err: (err as Error).message }, 'failed to kill gh copilot worker');
          }
        }
      }
    },
  };
}

function buildHeredoc(prompt: string): string {
  return prompt.replace(/AF_JUDGE_EOF/g, 'AF_JUDGE_EOF_X');
}
