// Optional/peer dependency ambient declarations so `tsc --noEmit` works before
// the master orchestrator runs `pnpm install`. The real, more specific
// typings (when packages are installed) take precedence over these fallbacks.

declare module 'sharp' {
  interface SharpMetadata {
    width?: number;
    height?: number;
    format?: string;
    channels?: number;
  }
  interface SharpInstance {
    resize(width: number, height: number, opts?: Record<string, unknown>): SharpInstance;
    greyscale(): SharpInstance;
    grayscale(): SharpInstance;
    threshold(value?: number): SharpInstance;
    normalise(): SharpInstance;
    normalize(): SharpInstance;
    png(opts?: Record<string, unknown>): SharpInstance;
    toBuffer(): Promise<Buffer>;
    metadata(): Promise<SharpMetadata>;
  }
  function sharp(input?: Buffer | string, opts?: Record<string, unknown>): SharpInstance;
  export = sharp;
}

declare module 'undici' {
  export function fetch(input: string, init?: Record<string, unknown>): Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    text(): Promise<string>;
    json(): Promise<unknown>;
  }>;
}

declare module 'openai';
declare module '@azure/openai';
