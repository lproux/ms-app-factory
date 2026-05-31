import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppFactoryError } from '@app-factory/shared';
import { selectProvider } from '../src/providers/index.js';
import { AzureOpenAiProvider } from '../src/providers/azure-openai.js';
import { OpenAiProvider } from '../src/providers/openai.js';
import { BedrockProvider } from '../src/providers/bedrock.js';

// A tiny opaque buffer we can recognise in assertions.
const PNG_FIXTURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_B64 = PNG_FIXTURE.toString('base64');

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
});

describe('selectProvider', () => {
  it('returns null when LOGO_PROVIDER is unset', async () => {
    expect(await selectProvider({})).toBeNull();
  });

  it('returns null when LOGO_PROVIDER=skip', async () => {
    expect(await selectProvider({ LOGO_PROVIDER: 'skip' })).toBeNull();
  });

  it('returns AzureOpenAiProvider for "azure-openai"', async () => {
    const p = await selectProvider({ LOGO_PROVIDER: 'azure-openai' });
    expect(p?.id).toBe('azure-openai');
  });

  it('returns OpenAiProvider for "openai"', async () => {
    const p = await selectProvider({ LOGO_PROVIDER: 'openai' });
    expect(p?.id).toBe('openai');
  });

  it('returns BedrockProvider for "bedrock"', async () => {
    const p = await selectProvider({ LOGO_PROVIDER: 'bedrock' });
    expect(p?.id).toBe('bedrock');
  });

  it('throws LOGO_PROVIDER_UNKNOWN for garbage', async () => {
    await expect(selectProvider({ LOGO_PROVIDER: 'midjourney' })).rejects.toMatchObject({
      code: 'LOGO_PROVIDER_UNKNOWN',
    });
  });
});

describe('AzureOpenAiProvider', () => {
  beforeEach(() => {
    vi.doMock('undici', () => ({
      fetch: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: PNG_B64 }] }),
        text: async () => '',
      })),
    }));
  });

  it('generate() returns image buffer on happy path', async () => {
    const provider = new AzureOpenAiProvider({
      LOGO_PROVIDER: 'azure-openai',
      AZURE_OPENAI_ENDPOINT: 'https://aoai.example.com',
      AZURE_OPENAI_DEPLOYMENT: 'dalle3',
      AZURE_OPENAI_API_KEY: 'fake-key',
    });
    const buf = await provider.generate('a friendly bot logo');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.equals(PNG_FIXTURE)).toBe(true);
  });

  it('throws LOGO_PROVIDER_NOT_CONFIGURED when endpoint/deployment missing', async () => {
    const provider = new AzureOpenAiProvider({ LOGO_PROVIDER: 'azure-openai' });
    let caught: AppFactoryError | undefined;
    try {
      await provider.generate('p');
    } catch (err) {
      caught = err as AppFactoryError;
    }
    expect(caught).toBeInstanceOf(AppFactoryError);
    expect(caught?.code).toBe('LOGO_PROVIDER_NOT_CONFIGURED');
    expect(caught?.recoverable).toBe(true);
  });
});

describe('OpenAiProvider', () => {
  beforeEach(() => {
    // Mock the openai SDK with a default-export class exposing images.generate().
    vi.doMock('openai', () => {
      class FakeOpenAI {
        readonly apiKey: string;
        readonly images = {
          generate: vi.fn(async () => ({ data: [{ b64_json: PNG_B64 }] })),
        };
        constructor(opts: { apiKey: string }) {
          this.apiKey = opts.apiKey;
        }
      }
      return { default: FakeOpenAI, OpenAI: FakeOpenAI };
    });
  });

  it('generate() returns image buffer on happy path', async () => {
    const provider = new OpenAiProvider({
      LOGO_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-fake',
    });
    const buf = await provider.generate('a friendly bot logo');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.equals(PNG_FIXTURE)).toBe(true);
  });

  it('throws LOGO_PROVIDER_NOT_CONFIGURED when OPENAI_API_KEY missing', async () => {
    const provider = new OpenAiProvider({ LOGO_PROVIDER: 'openai' });
    let caught: AppFactoryError | undefined;
    try {
      await provider.generate('p');
    } catch (err) {
      caught = err as AppFactoryError;
    }
    expect(caught).toBeInstanceOf(AppFactoryError);
    expect(caught?.code).toBe('LOGO_PROVIDER_NOT_CONFIGURED');
    expect(caught?.recoverable).toBe(true);
  });
});

describe('BedrockProvider', () => {
  beforeEach(() => {
    vi.doMock('@aws-sdk/client-bedrock-runtime', () => {
      const sendMock = vi.fn(async () => ({
        body: {
          transformToByteArray: async () =>
            new TextEncoder().encode(JSON.stringify({ images: [PNG_B64] })),
        },
      }));
      class BedrockRuntimeClient {
        readonly region: string;
        constructor(cfg: { region: string }) {
          this.region = cfg.region;
        }
        send = sendMock;
      }
      class InvokeModelCommand {
        readonly input: unknown;
        constructor(input: unknown) {
          this.input = input;
        }
      }
      return { BedrockRuntimeClient, InvokeModelCommand };
    });
  });

  it('generate() returns image buffer on happy path', async () => {
    const provider = new BedrockProvider({
      LOGO_PROVIDER: 'bedrock',
      AWS_REGION: 'us-west-2',
    });
    const buf = await provider.generate('a friendly bot logo');
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.equals(PNG_FIXTURE)).toBe(true);
  });

  it('throws LOGO_PROVIDER_NOT_CONFIGURED when AWS_REGION missing', async () => {
    const provider = new BedrockProvider({ LOGO_PROVIDER: 'bedrock' });
    let caught: AppFactoryError | undefined;
    try {
      await provider.generate('p');
    } catch (err) {
      caught = err as AppFactoryError;
    }
    expect(caught).toBeInstanceOf(AppFactoryError);
    expect(caught?.code).toBe('LOGO_PROVIDER_NOT_CONFIGURED');
    expect(caught?.recoverable).toBe(true);
  });
});
