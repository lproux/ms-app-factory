import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('logo-pipeline');

export interface LogoVariant {
  width: number;
  height: number;
  bytes: Buffer;
}

export interface LogoSet {
  color192: LogoVariant;
  outline32: LogoVariant;
  bytesRaw: Buffer;
}

export type LogoProvider = 'azure-openai' | 'openai' | 'skip';

export interface BuildLogoOptions {
  sourcePath?: string;
  promptHint?: string;
  provider?: LogoProvider;
  azure?: {
    endpoint: string;
    deployment: string;
    apiKey?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
  };
}

export async function buildLogoSet(opts: BuildLogoOptions = {}): Promise<LogoSet> {
  const raw = await resolveSourceBytes(opts);
  const color192 = await renderColor(raw, 192);
  const outline32 = await renderOutline(raw, 32);
  return { color192, outline32, bytesRaw: raw };
}

async function resolveSourceBytes(opts: BuildLogoOptions): Promise<Buffer> {
  if (opts.sourcePath) {
    log.debug({ sourcePath: opts.sourcePath }, 'using user-provided logo');
    return fs.readFile(opts.sourcePath);
  }
  const envProvider = (process.env['LOGO_PROVIDER'] as LogoProvider | undefined) ?? undefined;
  const provider = opts.provider ?? envProvider ?? 'skip';
  if (provider === 'skip') {
    throw new AppFactoryError('LOGO_MISSING', 'no logo source path supplied and provider=="skip"', {
      recoverable: true,
    });
  }
  if (provider === 'azure-openai') return generateAzureOpenAi(opts);
  if (provider === 'openai') return generateOpenAi(opts);
  throw new AppFactoryError('LOGO_PROVIDER_UNKNOWN', `unknown provider: ${String(provider)}`);
}

async function generateAzureOpenAi(opts: BuildLogoOptions): Promise<Buffer> {
  const endpoint = opts.azure?.endpoint ?? process.env['AZURE_OPENAI_ENDPOINT'];
  const deployment = opts.azure?.deployment ?? process.env['AZURE_OPENAI_IMAGE_DEPLOYMENT'];
  const apiKey = opts.azure?.apiKey ?? process.env['AZURE_OPENAI_API_KEY'];
  if (!endpoint || !deployment || !apiKey) {
    throw new AppFactoryError(
      'LOGO_PROVIDER_NOT_CONFIGURED',
      'Azure OpenAI image generation requires endpoint, deployment, and apiKey',
      { recoverable: true, details: { hasEndpoint: !!endpoint, hasDeployment: !!deployment, hasKey: !!apiKey } },
    );
  }
  try {
    // Dynamic import keeps `@azure/openai` optional.
    await import('@azure/openai');
  } catch {
    throw new AppFactoryError(
      'LOGO_PROVIDER_NOT_INSTALLED',
      '@azure/openai package is not installed — add it to enable Azure OpenAI image generation',
      { recoverable: true },
    );
  }
  // Direct REST call — keeps us compatible across SDK breaking changes.
  const url = `${endpoint.replace(/\/$/, '')}/openai/deployments/${encodeURIComponent(deployment)}/images/generations?api-version=2024-02-15-preview`;
  const undici = (await import('undici')) as unknown as {
    fetch: (u: string, init: Record<string, unknown>) => Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
      text(): Promise<string>;
    }>;
  };
  const res = await undici.fetch(url, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: opts.promptHint ?? 'A simple, modern, friendly app logo',
      size: '1024x1024',
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    throw new AppFactoryError('LOGO_PROVIDER_HTTP', `Azure OpenAI image returned ${res.status}`, {
      details: { body: (await res.text()).slice(0, 2000) },
    });
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new AppFactoryError('LOGO_PROVIDER_EMPTY', 'Azure OpenAI returned no image');
  return Buffer.from(b64, 'base64');
}

async function generateOpenAi(opts: BuildLogoOptions): Promise<Buffer> {
  const apiKey = opts.openai?.apiKey ?? process.env['OPENAI_API_KEY'];
  const model = opts.openai?.model ?? 'gpt-image-1';
  if (!apiKey) {
    throw new AppFactoryError(
      'LOGO_PROVIDER_NOT_CONFIGURED',
      'OpenAI image generation requires apiKey (set OPENAI_API_KEY)',
      { recoverable: true },
    );
  }
  try {
    await import('openai');
  } catch {
    throw new AppFactoryError(
      'LOGO_PROVIDER_NOT_INSTALLED',
      'openai package is not installed — add it to enable OpenAI image generation',
      { recoverable: true },
    );
  }
  const undici = (await import('undici')) as unknown as {
    fetch: (u: string, init: Record<string, unknown>) => Promise<{
      ok: boolean;
      status: number;
      json(): Promise<unknown>;
      text(): Promise<string>;
    }>;
  };
  const res = await undici.fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: opts.promptHint ?? 'A simple, modern, friendly app logo',
      size: '1024x1024',
      n: 1,
      response_format: 'b64_json',
    }),
  });
  if (!res.ok) {
    throw new AppFactoryError('LOGO_PROVIDER_HTTP', `OpenAI image returned ${res.status}`, {
      details: { body: (await res.text()).slice(0, 2000) },
    });
  }
  const body = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = body.data?.[0]?.b64_json;
  if (!b64) throw new AppFactoryError('LOGO_PROVIDER_EMPTY', 'OpenAI returned no image');
  return Buffer.from(b64, 'base64');
}

async function renderColor(raw: Buffer, size: number): Promise<LogoVariant> {
  const bytes = await sharp(raw)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .png()
    .toBuffer();
  return { width: size, height: size, bytes };
}

async function renderOutline(raw: Buffer, size: number): Promise<LogoVariant> {
  const bytes = await sharp(raw)
    .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 0 } })
    .grayscale()
    .normalize()
    .threshold(180)
    .png()
    .toBuffer();
  return { width: size, height: size, bytes };
}
