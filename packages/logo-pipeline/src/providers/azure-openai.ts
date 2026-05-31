import { Buffer } from 'node:buffer';
import { AppFactoryError, AuthError, createLogger } from '@app-factory/shared';
import type { ImageProvider, LogoProviderId, SelectProviderEnv } from './index.js';

const log = createLogger('logo-pipeline:azure-openai');

/**
 * Azure OpenAI image-generation provider (DALL-E 3 / equivalent deployment).
 *
 * Env vars:
 *  - `AZURE_OPENAI_ENDPOINT`   (required) — e.g. https://my-aoai.openai.azure.com
 *  - `AZURE_OPENAI_DEPLOYMENT` (required) — deployment name for an image model
 *  - `AZURE_OPENAI_API_VERSION` (optional, default `2024-02-15-preview`)
 *  - `AZURE_OPENAI_API_KEY`    (optional) — falls back to AAD token from `@app-factory/auth-broker`
 *  - `AZURE_TENANT_ID` etc.    — consumed by the auth-broker for token mode
 */
export class AzureOpenAiProvider implements ImageProvider {
  readonly id: LogoProviderId = 'azure-openai';
  readonly #env: SelectProviderEnv;

  constructor(env: SelectProviderEnv) {
    this.#env = env;
  }

  async generate(prompt: string): Promise<Buffer> {
    const endpoint = this.#env['AZURE_OPENAI_ENDPOINT'];
    const deployment = this.#env['AZURE_OPENAI_DEPLOYMENT'];
    const apiVersion = this.#env['AZURE_OPENAI_API_VERSION'] ?? '2024-02-15-preview';
    const apiKey = this.#env['AZURE_OPENAI_API_KEY'];

    if (!endpoint || !deployment) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_NOT_CONFIGURED',
        'Azure OpenAI provider requires AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT',
        {
          recoverable: true,
          details: { hasEndpoint: !!endpoint, hasDeployment: !!deployment },
        },
      );
    }

    // Verify the optional SDK is installed so we surface a clear error rather than a
    // confusing "fetch is not a function" when the package is absent.
    try {
      await import('@azure/openai');
    } catch (cause) {
      throw new AppFactoryError(
        'LOGO_PROVIDER_NOT_INSTALLED',
        '@azure/openai package is not installed — `pnpm add @azure/openai` in logo-pipeline to enable this provider',
        { recoverable: true, cause },
      );
    }

    // Resolve an Authorization header: prefer API key, else fall back to AAD via the auth-broker.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) {
      headers['api-key'] = apiKey;
    } else {
      const token = await acquireAadToken();
      headers['Authorization'] = `Bearer ${token}`;
    }

    const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(
      deployment,
    )}/images/generations?api-version=${encodeURIComponent(apiVersion)}`;

    log.debug({ deployment, apiVersion }, 'requesting Azure OpenAI image');
    const fetchFn = await loadFetch();
    const res = await fetchFn(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt,
        size: '1024x1024',
        n: 1,
        response_format: 'b64_json',
      }),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new AppFactoryError('LOGO_PROVIDER_HTTP', `Azure OpenAI image returned ${res.status}`, {
        details: { status: res.status, body: body.slice(0, 2000) },
      });
    }
    const body = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
    const first = body.data?.[0];
    if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
    if (first?.url) return downloadUrl(first.url);
    throw new AppFactoryError('LOGO_PROVIDER_EMPTY', 'Azure OpenAI returned no image data');
  }
}

async function acquireAadToken(): Promise<string> {
  let mod: typeof import('@app-factory/auth-broker');
  try {
    mod = await import('@app-factory/auth-broker');
  } catch (cause) {
    throw new AuthError(
      'cannot acquire AAD token: @app-factory/auth-broker not resolvable from logo-pipeline',
      { cause },
    );
  }
  const credential = mod.getCredential({ mode: 'chained' });
  const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
  if (!token?.token) {
    throw new AuthError('AAD credential returned no token for Cognitive Services scope');
  }
  return token.token;
}

interface MinimalResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

type MinimalFetch = (url: string, init?: Record<string, unknown>) => Promise<MinimalResponse>;

async function loadFetch(): Promise<MinimalFetch> {
  const undici = (await import('undici')) as unknown as { fetch: MinimalFetch };
  return undici.fetch;
}

async function downloadUrl(url: string): Promise<Buffer> {
  const fetchFn = await loadFetch();
  const res = await fetchFn(url);
  if (!res.ok || !res.arrayBuffer) {
    throw new AppFactoryError('LOGO_PROVIDER_HTTP', `failed to download generated image: ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

async function safeText(res: MinimalResponse): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
