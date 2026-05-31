import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('portal-automation:computer-use');

export interface ComputerUseTask {
  goal: string;
  url?: string;
  context?: Record<string, unknown>;
}

const COMPUTER_USE_MODEL = 'claude-sonnet-4-5-20250929';
const COMPUTER_USE_BETA = 'computer-use-2025-01-24';

/**
 * Keys whose values look like credentials, tokens or other secret material.
 * Matches case-insensitively: `secret`, `password`, `token`, `key`,
 * `client_secret`/`clientSecret`, `user_code`/`userCode`, `api_key`/`apiKey`.
 *
 * Used by {@link redactSecrets} to scrub `task.context` before it is
 * embedded in an Anthropic API payload. A trace.zip or upstream model log
 * would otherwise capture passwords typed by the orchestrator verbatim.
 */
export const SECRET_KEY_PATTERN = /secret|password|token|key|client_?secret|user_?code|api_?key/i;

const REDACTED_PLACEHOLDER = '<redacted>';

/**
 * Recursively walk a value and replace the values of any object keys matching
 * {@link SECRET_KEY_PATTERN} with the literal string `<redacted>`. Arrays are
 * mapped element-wise; primitives are returned unchanged. The input is not
 * mutated — a fresh structure is returned so the original `task.context` can
 * still be used internally by the caller.
 */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(k)) {
        out[k] = REDACTED_PLACEHOLDER;
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return value;
}

export async function runComputerUseTask(task: ComputerUseTask): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AppFactoryError(
      'COMPUTER_USE_NO_KEY',
      'ANTHROPIC_API_KEY is not set; computer-use fallback disabled.',
      { recoverable: true },
    );
  }

  log.info({ goal: task.goal, url: task.url }, 'invoking computer-use fallback');

  // @ts-ignore - @anthropic-ai/sdk is loaded lazily; install via `pnpm install` before use.
  const sdkModule = await import('@anthropic-ai/sdk');
  // biome-ignore lint/suspicious/noExplicitAny: SDK module shape varies by version
  const sdk = sdkModule as any;
  const Anthropic = sdk.default ?? sdk.Anthropic ?? sdk;
  // biome-ignore lint/suspicious/noExplicitAny: SDK client shape varies by version
  const client = new Anthropic({ apiKey }) as any;

  const safeContext = redactSecrets(task.context ?? {});

  // TODO: replace this single-turn stub with the full tool-use loop
  // (screenshot → model → action → screenshot → ...) once the package is
  // wired into the master orchestrator end-to-end. The exact API surface
  // of beta computer-use in @anthropic-ai/sdk is still evolving — the `as never`
  // cast here is intentional and documented.
  const result = await client.beta.messages.create({
    model: COMPUTER_USE_MODEL,
    max_tokens: 1024,
    tools: [
      {
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: 1280,
        display_height_px: 800,
        display_number: 1,
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Goal: ${task.goal}\nURL: ${task.url ?? '(none provided)'}\nContext: ${JSON.stringify(safeContext)}`,
      },
    ],
    betas: [COMPUTER_USE_BETA],
  } as never);

  return JSON.stringify(result);
}
