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
  export function convertToMarkdown(input: { path?: string; buffer?: Buffer }): Promise<{
    value: string;
    messages: unknown[];
  }>;
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
