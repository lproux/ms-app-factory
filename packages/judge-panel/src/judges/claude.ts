import { AppFactoryError, createLogger } from '@app-factory/shared';
import { buildPrompt, parseVerdict } from '../personas.js';
import type { Judge, JudgeArtifact, Persona, Verdict } from '../types.js';

const log = createLogger('judge-panel:claude');

const DEFAULT_MODEL = 'claude-opus-4-5';

export interface ClaudeJudgeOptions {
  persona: Persona;
  apiKey?: string;
  model?: string;
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}

interface AnthropicMessage {
  content?: AnthropicTextBlock[];
}

interface AnthropicMessagesApi {
  create(params: {
    model: string;
    max_tokens: number;
    messages: { role: 'user'; content: string }[];
  }): Promise<AnthropicMessage>;
}

interface AnthropicClient {
  messages: AnthropicMessagesApi;
}

type AnthropicCtor = new (cfg: { apiKey: string }) => AnthropicClient;

let cachedCtor: AnthropicCtor | undefined;

async function loadAnthropic(): Promise<AnthropicCtor> {
  if (cachedCtor) return cachedCtor;
  try {
    const mod = (await import('@anthropic-ai/sdk')) as unknown as {
      default?: AnthropicCtor;
      Anthropic?: AnthropicCtor;
    };
    const ctor = mod.default ?? mod.Anthropic;
    if (!ctor) {
      throw new AppFactoryError(
        'CLAUDE_SDK_SHAPE',
        '@anthropic-ai/sdk did not expose a default or Anthropic export',
        { recoverable: true },
      );
    }
    cachedCtor = ctor;
    return ctor;
  } catch (err) {
    if (err instanceof AppFactoryError) throw err;
    throw new AppFactoryError(
      'CLAUDE_SDK_UNAVAILABLE',
      `Failed to load @anthropic-ai/sdk: ${(err as Error).message}`,
      { recoverable: true, cause: err },
    );
  }
}

export function makeClaudeJudge(opts: ClaudeJudgeOptions): Judge {
  const persona = opts.persona;
  const id = `claude:${persona}`;
  const model = opts.model ?? DEFAULT_MODEL;

  return {
    id,
    persona,
    async review(artifact: JudgeArtifact): Promise<Verdict> {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new AppFactoryError(
          'CLAUDE_JUDGE_NO_KEY',
          'Claude judge requires ANTHROPIC_API_KEY (set env var or pass opts.apiKey)',
          { recoverable: true, details: { persona, judge: id } },
        );
      }
      const Ctor = await loadAnthropic();
      const client = new Ctor({ apiKey });
      const prompt = buildPrompt(persona, artifact);
      log.debug({ judge: id, model, artifact: artifact.id }, 'submitting to claude');
      const resp = await client.messages.create({
        model,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      const text =
        (resp.content ?? [])
          .filter((b): b is AnthropicTextBlock & { text: string } => typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim() || '{}';
      return parseVerdict(text, id, persona);
    },
  };
}
