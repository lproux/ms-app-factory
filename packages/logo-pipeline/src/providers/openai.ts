import { Buffer } from 'node:buffer';
import { AppFactoryError, createLogger } from '@app-factory/shared';
import type { ImageProvider, LogoProviderId, SelectProviderEnv } from './index.js';

const log = createLogger('logo-pipeline:openai');

/**
 * OpenAI image-generation provider (gpt-image-1 / DALL-E).
 *
 * Env vars:
 *  - `OPENAI_API_KEY`    (required)
 *  - `OPENAI_IMAGE_MODEL` (optional, default `gpt-image-1`)
 *  - `OPENAI_BASE_URL`   (optional, default `https://api.openai.com/v1`)
 */
export class OpenAiProvider implements ImageProvider {
  readonly id: LogoProviderId = 'openai';
  readonly #env: SelectProviderEnv;

  constructor(env: SelectProviderEnv) {
    this.#env = env;
  }

  async generate(prompt: string): Promise<Buffer> {
    const apiKey = this.#env['OPENAI_API_KEY'];
    const model = this.#env['OPENAI_IMAGE_MODEL'] ?? 'gpt-image-1';
    const baseUrl = (this.#env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1').replace(/\/$/, '');

    if (!apiKey) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_NOT_CONFIGURED',
        'OpenAI provider requires OPENAI_API_KEY',
        { recoverable: true },
      );
    }

    // Probe the optional SDK so a missing install surfaces a clear error.
    let sdk: typeof import('openai') | undefined;
    try {
      sdk = (await import('openai')) as typeof import('openai');
    } catch (cause) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_NOT_INSTALLED',
        'openai package is not installed — `pnpm add openai` in logo-pipeline to enable this provider',
        { recoverable: true, cause },
      );
    }

    log.debug({ model }, 'requesting OpenAI image');

    // Prefer the SDK when available — it handles retries, but we accept the lower-level
    // REST path as a fallback if the SDK shape changes in a future major version.
    try {
      const sdkAny = sdk as unknown as {
        default?: new (opts: { apiKey: string; baseURL?: string }) => {
          images: {
            generate(req: {
              model: string;
              prompt: string;
              n?: number;
              size?: string;
              response_format?: string;
            }): Promise<{ data?: { b64_json?: string; url?: string }[] }>;
          };
        };
        OpenAI?: new (opts: { apiKey: string; baseURL?: string }) => {
          images: {
            generate(req: {
              model: string;
              prompt: string;
              n?: number;
              size?: string;
              response_format?: string;
            }): Promise<{ data?: { b64_json?: string; url?: string }[] }>;
          };
        };
      };
      const Ctor = sdkAny.default ?? sdkAny.OpenAI;
      if (!Ctor) throw new Error('openai SDK has no default/OpenAI export');
      const client = new Ctor({ apiKey, baseURL: baseUrl });
      const resp = await client.images.generate({
        model,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json',
      });
      const first = resp.data?.[0];
      if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
      if (first?.url) return downloadUrl(first.url);
      throw new AppFactoryError('LOGO_PROVIDER_EMPTY', 'OpenAI returned no image data');
    } catch (err) {
      if (err instanceof AppFactoryError) throw err;
      throw new AppFactoryError('LOGO_PROVIDER_HTTP', `OpenAI image generation failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
}

interface MinimalResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type MinimalFetch = (url: string, init?: Record<string, unknown>) => Promise<MinimalResponse>;

async function downloadUrl(url: string): Promise<Buffer> {
  const undici = (await import('undici')) as unknown as { fetch: MinimalFetch };
  const res = await undici.fetch(url);
  if (!res.ok) {
    throw new AppFactoryError('LOGO_PROVIDER_HTTP', `failed to download generated image: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
