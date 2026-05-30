import { AppFactoryError, createLogger } from '@app-factory/shared';
import { buildPrompt, parseVerdict } from '../personas.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../types.js';

const log = createLogger('judge-panel:copilot-studio');

const DEFAULT_BASE_URL = 'https://directline.botframework.com';
const POLL_BUDGET_MS = 10_000;
const POLL_INTERVAL_MS = 750;

export interface CopilotStudioJudgeOptions {
  persona: Persona;
  directLineSecret?: string;
  userId?: string;
  baseUrl?: string;
}

interface ConversationStart {
  conversationId?: string;
  token?: string;
  streamUrl?: string;
}

interface Activity {
  type?: string;
  from?: { id?: string; role?: string };
  text?: string;
  id?: string;
  timestamp?: string;
}

interface ActivitiesPage {
  activities?: Activity[];
  watermark?: string;
}

export function makeCopilotStudioJudge(opts: CopilotStudioJudgeOptions): Judge {
  const persona = opts.persona;
  const id = `cs:${persona}`;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const userId = opts.userId ?? `app-factory-judge-${persona}`;

  return {
    id,
    persona,
    async review(artifact: JudgeArtifact): Promise<Verdict> {
      const secret = opts.directLineSecret ?? process.env.COPILOT_STUDIO_JUDGE_SECRET;
      if (!secret) {
        throw new AppFactoryError(
          'CS_JUDGE_NO_SECRET',
          'Copilot Studio judge requires a Direct Line secret (opts.directLineSecret or COPILOT_STUDIO_JUDGE_SECRET)',
          { recoverable: true, details: { judge: id } },
        );
      }
      const prompt = buildPrompt(persona, artifact);

      const startResp = await fetch(`${baseUrl}/v3/directline/conversations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (!startResp.ok) {
        throw new AppFactoryError(
          'CS_JUDGE_HTTP',
          `Direct Line conversation start failed: ${startResp.status} ${startResp.statusText}`,
          { recoverable: true, details: { judge: id, status: startResp.status } },
        );
      }
      const start = (await startResp.json()) as ConversationStart;
      const conversationId = start.conversationId;
      const token = start.token ?? secret;
      if (!conversationId) {
        throw new AppFactoryError(
          'CS_JUDGE_HTTP',
          'Direct Line conversation start returned no conversationId',
          { recoverable: true, details: { judge: id } },
        );
      }
      log.debug({ judge: id, conversationId }, 'opened direct line conversation');

      const postResp = await fetch(
        `${baseUrl}/v3/directline/conversations/${encodeURIComponent(conversationId)}/activities`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'message',
            from: { id: userId, role: 'user' },
            text: prompt,
          }),
        },
      );
      if (!postResp.ok) {
        throw new AppFactoryError(
          'CS_JUDGE_HTTP',
          `Direct Line post-activity failed: ${postResp.status} ${postResp.statusText}`,
          { recoverable: true, details: { judge: id, status: postResp.status } },
        );
      }

      const deadline = Date.now() + POLL_BUDGET_MS;
      let watermark: string | undefined;
      let lastBotText = '';
      while (Date.now() < deadline) {
        const url = new URL(
          `${baseUrl}/v3/directline/conversations/${encodeURIComponent(conversationId)}/activities`,
        );
        if (watermark) url.searchParams.set('watermark', watermark);
        const pageResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (pageResp.ok) {
          const page = (await pageResp.json()) as ActivitiesPage;
          watermark = page.watermark ?? watermark;
          for (const act of page.activities ?? []) {
            if (act.type !== 'message') continue;
            if (act.from?.id === userId) continue;
            if (typeof act.text === 'string' && act.text.trim().length > 0) {
              lastBotText = act.text;
            }
          }
          if (lastBotText) break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      if (!lastBotText) {
        throw new AppFactoryError(
          'CS_JUDGE_TIMEOUT',
          `Copilot Studio judge produced no reply within ${POLL_BUDGET_MS}ms`,
          { recoverable: true, details: { judge: id } },
        );
      }

      return parseVerdict(lastBotText, id, persona);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
