import { Buffer } from 'node:buffer';
import { AppFactoryError, createLogger } from '@app-factory/shared';
import type { ImageProvider, LogoProviderId, SelectProviderEnv } from './index.js';

const log = createLogger('logo-pipeline:bedrock');

/**
 * AWS Bedrock image-generation provider (default: Stability AI Stable Image Ultra).
 *
 * Env vars:
 *  - `AWS_REGION`           (required) — e.g. `us-west-2`
 *  - `AWS_ACCESS_KEY_ID`    (optional — falls back to default AWS SDK credential chain)
 *  - `AWS_SECRET_ACCESS_KEY` (optional — same)
 *  - `BEDROCK_IMAGE_MODEL_ID` (optional, default `stability.stable-image-ultra-v1:0`)
 */
export class BedrockProvider implements ImageProvider {
  readonly id: LogoProviderId = 'bedrock';
  readonly #env: SelectProviderEnv;

  constructor(env: SelectProviderEnv) {
    this.#env = env;
  }

  async generate(prompt: string): Promise<Buffer> {
    const region = this.#env['AWS_REGION'];
    const modelId = this.#env['BEDROCK_IMAGE_MODEL_ID'] ?? 'stability.stable-image-ultra-v1:0';
    if (!region) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_NOT_CONFIGURED',
        'Bedrock provider requires AWS_REGION',
        { recoverable: true },
      );
    }

    let sdk: typeof import('@aws-sdk/client-bedrock-runtime') | undefined;
    try {
      sdk = (await import('@aws-sdk/client-bedrock-runtime')) as typeof import('@aws-sdk/client-bedrock-runtime');
    } catch (cause) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_NOT_INSTALLED',
        '@aws-sdk/client-bedrock-runtime package is not installed — `pnpm add @aws-sdk/client-bedrock-runtime` in logo-pipeline to enable this provider',
        { recoverable: true, cause },
      );
    }

    const sdkAny = sdk as unknown as {
      BedrockRuntimeClient: new (cfg: { region: string }) => {
        send(cmd: unknown): Promise<{ body?: Uint8Array | { transformToByteArray?: () => Promise<Uint8Array> } }>;
      };
      InvokeModelCommand: new (input: {
        modelId: string;
        contentType: string;
        accept: string;
        body: string;
      }) => unknown;
    };

    const client = new sdkAny.BedrockRuntimeClient({ region });
    const command = new sdkAny.InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        prompt,
        output_format: 'png',
        aspect_ratio: '1:1',
      }),
    });

    log.debug({ region, modelId }, 'invoking Bedrock image model');
    let response: { body?: Uint8Array | { transformToByteArray?: () => Promise<Uint8Array> } };
    try {
      response = await client.send(command);
    } catch (err) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_HTTP',
        `Bedrock invoke failed: ${(err as Error).message}`,
        { cause: err },
      );
    }

    const bytes = await readBody(response.body);
    if (!bytes) throw new AppFactoryError('LOGO_PROVIDER_EMPTY', 'Bedrock returned no body');

    const text = Buffer.from(bytes).toString('utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some Bedrock providers stream raw image bytes; if it isn't valid JSON, treat as binary.
      return Buffer.from(bytes);
    }
    const b64 = extractImageB64(parsed);
    if (!b64) throw new AppFactoryError('LOGO_PROVIDER_EMPTY', 'Bedrock response missing image payload');
    return Buffer.from(b64, 'base64');
  }
}

async function readBody(
  body: Uint8Array | { transformToByteArray?: () => Promise<Uint8Array> } | undefined,
): Promise<Uint8Array | null> {
  if (!body) return null;
  if (body instanceof Uint8Array) return body;
  if (typeof body.transformToByteArray === 'function') return body.transformToByteArray();
  return null;
}

function extractImageB64(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  // Stable Image Ultra response shape: { images: [b64], finish_reasons: [...] }
  const images = obj['images'];
  if (Array.isArray(images) && typeof images[0] === 'string') return images[0];
  // Older SDXL shape: { artifacts: [{ base64: ... }] }
  const artifacts = obj['artifacts'];
  if (Array.isArray(artifacts) && artifacts[0] && typeof artifacts[0] === 'object') {
    const first = artifacts[0] as Record<string, unknown>;
    const b64 = first['base64'];
    if (typeof b64 === 'string') return b64;
  }
  return null;
}
