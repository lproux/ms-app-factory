import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('portal:computer-use');

export interface ComputerUseTask {
  goal: string;
  url?: string;
  context?: Record<string, unknown>;
}

const COMPUTER_USE_MODEL = 'claude-sonnet-4-5-20250929';
const COMPUTER_USE_BETA = 'computer-use-2025-01-24';

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
        content: `Goal: ${task.goal}\nURL: ${task.url ?? '(none provided)'}\nContext: ${JSON.stringify(task.context ?? {})}`,
      },
    ],
    betas: [COMPUTER_USE_BETA],
  } as never);

  return JSON.stringify(result);
}
