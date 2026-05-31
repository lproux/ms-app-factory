import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';
import { AppFactoryError, createLogger } from '@app-factory/shared';
import { selectProvider, type ImageProvider, type LogoProviderId } from './providers/index.js';

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

/**
 * Legacy alias kept for back-compat with earlier shipped versions of this package.
 * The canonical type now lives in `./providers/index.ts`.
 */
export type LogoProvider = LogoProviderId;

export interface BuildLogoOptions {
  /** Path to a user-supplied logo file; takes precedence over any provider. */
  sourcePath?: string;
  /** Optional caller-provided prompt; if absent we synthesise one from `brand`. */
  promptHint?: string;
  /** Brand metadata used to construct the image-gen prompt when falling back. */
  brand?: {
    name?: string;
    greeting?: string;
  };
  /** Recipe id woven into the prompt — gives image models stylistic context. */
  recipeId?: string;
  /** Override the provider selector — primarily for tests. */
  provider?: ImageProvider | null;
  /** Override `process.env` for provider selection — primarily for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Build the canonical logo variant set for an App Factory run.
 *
 * Precedence:
 *   1. `opts.sourcePath` — user-supplied file is used verbatim.
 *   2. `LOGO_PROVIDER` env var → matching `ImageProvider` generates one.
 *   3. Neither → log a warning and throw `AppFactoryError("LOGO_MISSING")`
 *      (recoverable=true) so callers can fall back to a placeholder.
 */
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

  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const provider =
    opts.provider === undefined ? await selectProvider(env) : opts.provider;

  if (!provider) {
    log.warn(
      'no logoPath supplied and LOGO_PROVIDER is unset (or "skip"); using placeholder fallback. Set LOGO_PROVIDER=azure-openai|openai|bedrock to auto-generate a logo.',
    );
    throw new AppFactoryError(
      'LOGO_MISSING',
      'no logo source path supplied and no LOGO_PROVIDER configured',
      { recoverable: true },
    );
  }

  const prompt = buildPrompt(opts);
  log.info({ provider: provider.id, promptPreview: prompt.slice(0, 120) }, 'generating logo via provider');
  return provider.generate(prompt);
}

/**
 * Compose the prompt fed to image-gen providers. Includes brand name + greeting
 * + recipe id so the resulting logo has stylistic context. Caller-supplied
 * `promptHint` wins outright if present.
 */
export function buildPrompt(opts: BuildLogoOptions): string {
  if (opts.promptHint && opts.promptHint.trim().length > 0) return opts.promptHint;
  const name = opts.brand?.name?.trim() || 'an AI agent';
  const greeting = opts.brand?.greeting?.trim();
  const recipe = opts.recipeId?.trim();
  const parts = [
    `A clean, modern, friendly square app icon for "${name}"`,
    greeting ? `evoking the greeting: "${greeting}"` : '',
    recipe ? `for the App Factory recipe "${recipe}"` : '',
    'flat vector style, soft gradients, transparent background, no text, centred subject, 1024x1024',
  ].filter((s) => s.length > 0);
  return parts.join(', ');
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

export { selectProvider } from './providers/index.js';
export type { ImageProvider, LogoProviderId, SelectProviderEnv } from './providers/index.js';
