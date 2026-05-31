import type { Buffer } from 'node:buffer';

export type LogoProviderId = 'azure-openai' | 'openai' | 'bedrock' | 'skip';

/**
 * Pluggable image-generation provider. Implementations must accept a
 * single text prompt and resolve to a raw image buffer (typically PNG/JPEG)
 * suitable for handing to `sharp` for resizing.
 */
export interface ImageProvider {
  readonly id: LogoProviderId;
  generate(prompt: string): Promise<Buffer>;
}

export interface SelectProviderEnv {
  LOGO_PROVIDER?: string | undefined;
  [key: string]: string | undefined;
}

/**
 * Read `LOGO_PROVIDER` from `env` and return a provider implementation,
 * or `null` if the user opted out (unset, empty, or `skip`).
 *
 * Throws `AppFactoryError("LOGO_PROVIDER_UNKNOWN")` if the value is
 * non-empty but unrecognised.
 */
export async function selectProvider(env: SelectProviderEnv): Promise<ImageProvider | null> {
  const raw = (env['LOGO_PROVIDER'] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'skip') return null;
  if (raw === 'azure-openai') {
    const { AzureOpenAiProvider } = await import('./azure-openai.js');
    return new AzureOpenAiProvider(env);
  }
  if (raw === 'openai') {
    const { OpenAiProvider } = await import('./openai.js');
    return new OpenAiProvider(env);
  }
  if (raw === 'bedrock') {
    const { BedrockProvider } = await import('./bedrock.js');
    return new BedrockProvider(env);
  }
  const { AppFactoryError } = await import('@app-factory/shared');
  throw new AppFactoryError('LOGO_PROVIDER_UNKNOWN', `unknown LOGO_PROVIDER: ${raw}`, {
    recoverable: true,
    details: { value: raw },
  });
}
