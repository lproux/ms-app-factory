// Ambient declarations for optional / not-yet-installed peer dependencies.
// These let `tsc --noEmit` succeed before `pnpm install` has been run by the
// fleet's master orchestrator. Once the real packages land in node_modules
// the package-provided typings (more specific) take precedence over these
// permissive fallbacks.

declare module 'adm-zip' {
  class AdmZip {
    constructor(path?: string);
    addLocalFolder(localPath: string, zipPath?: string): void;
    addLocalFile(localPath: string, zipPath?: string, zipName?: string): void;
    addFile(entryName: string, data: Buffer, comment?: string, attr?: number): void;
    writeZip(targetPath: string): void;
    toBuffer(): Buffer;
  }
  export = AdmZip;
}

declare module 'simple-git' {
  export interface SimpleGit {
    clone(repo: string, localPath: string, options?: string[]): Promise<unknown>;
  }
  export function simpleGit(baseDir?: string): SimpleGit;
  const _default: { simpleGit: typeof simpleGit };
  export default _default;
}

declare module 'mammoth' {
  export function convertToHtml(input: { path?: string; buffer?: Buffer }): Promise<{
    value: string;
    messages: unknown[];
  }>;
  export function extractRawText(input: { path?: string; buffer?: Buffer }): Promise<{
    value: string;
    messages: unknown[];
  }>;
}

declare module 'pdf-parse' {
  interface PdfData {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(buffer: Buffer | Uint8Array, opts?: Record<string, unknown>): Promise<PdfData>;
  export = pdfParse;
}

declare module '@aws-sdk/client-s3' {
  export interface S3ListObjectsV2Output {
    Contents?: Array<{ Key?: string; Size?: number }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  }
  export interface S3GetObjectOutput {
    Body?: { transformToByteArray(): Promise<Uint8Array> } & AsyncIterable<Uint8Array>;
    ContentType?: string;
  }
  export class S3Client {
    constructor(config?: Record<string, unknown>);
    send<T = unknown>(command: unknown): Promise<T>;
    destroy(): void;
  }
  export class ListObjectsV2Command {
    constructor(input: { Bucket: string; Prefix?: string; ContinuationToken?: string; MaxKeys?: number });
  }
  export class GetObjectCommand {
    constructor(input: { Bucket: string; Key: string });
  }
}

declare module '@aws-sdk/credential-providers' {
  import type { TokenCredential } from '@azure/identity';
  export function fromIni(opts?: { profile?: string }): unknown;
  export function fromEnv(): unknown;
  export function fromNodeProviderChain(opts?: Record<string, unknown>): unknown;
  // Suppress unused import warning
  export type _Unused = TokenCredential;
}

declare module '@google-cloud/storage' {
  export interface GcsFile {
    name: string;
    download(): Promise<[Buffer]>;
  }
  export interface GcsBucket {
    getFiles(opts?: { prefix?: string; maxResults?: number; pageToken?: string; autoPaginate?: boolean }):
      Promise<[GcsFile[], unknown, { nextPageToken?: string } | undefined]>;
    file(name: string): GcsFile;
  }
  export class Storage {
    constructor(opts?: { projectId?: string; keyFilename?: string });
    bucket(name: string): GcsBucket;
  }
}

declare module '@microsoft/microsoft-graph-client' {
  export interface AuthProvider {
    getAccessToken(): Promise<string>;
  }
  export interface ClientOptions {
    authProvider: AuthProvider;
    defaultVersion?: string;
  }
  export interface GraphRequest {
    select(...args: string[]): GraphRequest;
    expand(...args: string[]): GraphRequest;
    header(key: string, value: string): GraphRequest;
    headers(headers: Record<string, string>): GraphRequest;
    query(qs: string | Record<string, unknown>): GraphRequest;
    get<T = unknown>(): Promise<T>;
    post<T = unknown>(body: unknown): Promise<T>;
    put<T = unknown>(body: unknown): Promise<T>;
    patch<T = unknown>(body: unknown): Promise<T>;
    delete<T = unknown>(): Promise<T>;
    putStream(stream: unknown): Promise<unknown>;
  }
  export class Client {
    static init(opts: { authProvider: (cb: (err: Error | null, token?: string) => void) => void }): Client;
    static initWithMiddleware(opts: ClientOptions): Client;
    api(path: string): GraphRequest;
  }
}

declare module 'isomorphic-fetch';
declare module 'playwright';
declare module 'turndown' {
  class TurndownService {
    constructor(opts?: Record<string, unknown>);
    turndown(html: string): string;
  }
  export = TurndownService;
}
