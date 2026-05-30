import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';
import { createLogger, AppFactoryError, type KbSource, type KbSourceKind } from '@app-factory/shared';
import { getCredential } from '@app-factory/auth-broker';
import { spawn } from '@app-factory/orchestrator';
import { DataverseClient } from './dataverse.js';

const log = createLogger('copilot-studio:kb-upload');

export interface KbDispatchOptions {
  siteId?: string;
  driveId?: string;
  libraryName?: string;
  agentRecordId?: string;
  dataverseUrl?: string;
  siteAddress?: string;
  /** Override the File Sync entity set name (kit-customizable). */
  fileSyncEntitySet?: string;
  /** Override File Sync column names (kit-customizable). */
  fileSyncColumns?: Partial<FileSyncColumns>;
  /** Tenant id (forwarded to the credential chain). */
  tenantId?: string;
  /** Cap on URL crawl depth (default 2). */
  maxDepth?: number;
  /** Cap on URL crawl pages. */
  maxPages?: number;
}

export interface FileSyncColumns {
  agentId: string;
  dataverseUrl: string;
  siteAddress: string;
  libraryName: string;
  folderPath: string;
  filter: string;
}

export const DEFAULT_FILE_SYNC_COLUMNS: FileSyncColumns = {
  agentId: 'cat_agentid',
  dataverseUrl: 'cat_dataverseurl',
  siteAddress: 'cat_siteaddress',
  libraryName: 'cat_libraryname',
  folderPath: 'cat_folderpath',
  filter: 'cat_filter',
};

export interface KbUploadResult {
  kind: KbSourceKind;
  uploaded: number;
  warnings: string[];
}

export async function uploadKb(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  log.info({ kind: source.kind, uri: source.uri }, 'kb dispatch');
  switch (source.kind) {
    case 'local':
      return uploadLocal(source, opts);
    case 'sharepoint':
      return wireSharePoint(source, opts);
    case 'url':
      return uploadUrl(source, opts);
    case 'github':
      return uploadGithub(source, opts);
    case 'aws-s3':
      return stubConnector('aws-s3');
    case 'gcp-gcs':
      return stubConnector('gcp-gcs');
    case 'foundry':
      return stubConnector('foundry');
    case 'm365-admin':
      return stubConnector('m365-admin');
    default: {
      // Exhaustiveness guard — exposes new KbSourceKind values immediately.
      const _x: never = source.kind;
      void _x;
      throw new AppFactoryError('KB_UNKNOWN_KIND', `unknown KbSource.kind: ${String(source.kind)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Graph client (SharePoint drive uploads)
// ---------------------------------------------------------------------------

interface GraphLike {
  api(path: string): {
    put<T = unknown>(body: unknown): Promise<T>;
    post<T = unknown>(body: unknown): Promise<T>;
    headers(h: Record<string, string>): { put<T = unknown>(body: unknown): Promise<T> };
  };
}

async function loadGraphClient(opts: KbDispatchOptions): Promise<GraphLike> {
  // Lazy import so the bundle doesn't choke if the optional dep is missing.
  // The `isomorphic-fetch` polyfill is required by the Graph SDK in Node < 18.
  try {
    await import('isomorphic-fetch');
  } catch {
    // ignore — native fetch is fine on Node 22.
  }
  const mod = (await import('@microsoft/microsoft-graph-client')) as unknown as {
    Client: {
      initWithMiddleware: (cfg: {
        authProvider: { getAccessToken(): Promise<string> };
      }) => GraphLike;
    };
  };
  const cred = getCredential({ mode: 'chained', tenantId: opts.tenantId });
  return mod.Client.initWithMiddleware({
    authProvider: {
      async getAccessToken() {
        const tok = await cred.getToken('https://graph.microsoft.com/.default');
        if (!tok) throw new AppFactoryError('KB_GRAPH_NO_TOKEN', 'no graph token');
        return tok.token;
      },
    },
  });
}

function drivePath(opts: KbDispatchOptions): string {
  if (opts.driveId) return `/drives/${opts.driveId}`;
  if (opts.siteId) return `/sites/${opts.siteId}/drive`;
  return '/drive'; // appCatalog default — caller should usually set siteId/driveId.
}

async function graphUploadBytes(
  graph: GraphLike,
  opts: KbDispatchOptions,
  destPath: string,
  bytes: Buffer,
  contentType: string,
): Promise<void> {
  const base = drivePath(opts);
  if (bytes.byteLength <= 4 * 1024 * 1024) {
    await graph
      .api(`${base}/root:/${encodeUriPath(destPath)}:/content`)
      .headers({ 'Content-Type': contentType })
      .put(bytes);
    return;
  }
  const session = (await graph
    .api(`${base}/root:/${encodeUriPath(destPath)}:/createUploadSession`)
    .post<{ uploadUrl: string }>({
      item: { '@microsoft.graph.conflictBehavior': 'replace' },
    })) as { uploadUrl: string };
  const chunkSize = 5 * 1024 * 1024;
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const end = Math.min(cursor + chunkSize, bytes.byteLength);
    const chunk = bytes.subarray(cursor, end);
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.byteLength),
        'Content-Range': `bytes ${cursor}-${end - 1}/${bytes.byteLength}`,
      },
      body: new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) as unknown as BodyInit,
    });
    if (!res.ok && res.status !== 202) {
      throw new AppFactoryError('KB_UPLOAD_CHUNK_FAILED', `chunk upload failed: ${res.status}`);
    }
    cursor = end;
  }
}

function encodeUriPath(p: string): string {
  return p
    .split('/')
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

// ---------------------------------------------------------------------------
// Local files → SharePoint
// ---------------------------------------------------------------------------

async function walkLocal(root: string, base = ''): Promise<{ rel: string; abs: string }[]> {
  const out: { rel: string; abs: string }[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const ent of entries) {
    const abs = path.join(root, ent.name);
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      out.push(...(await walkLocal(abs, rel)));
    } else if (ent.isFile()) {
      out.push({ rel, abs });
    }
  }
  return out;
}

async function uploadLocal(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const warnings: string[] = [];
  const root = source.uri;
  const stat = await fs.stat(root).catch(() => undefined);
  if (!stat) {
    warnings.push(`local path missing: ${root}`);
    return { kind: 'local', uploaded: 0, warnings };
  }
  const graph = await loadGraphClient(opts);
  const files = stat.isFile() ? [{ rel: path.basename(root), abs: root }] : await walkLocal(root);
  const lib = opts.libraryName ?? 'AppFactoryKB';
  let uploaded = 0;
  for (const f of files) {
    const dest = `${lib}/${f.rel}`;
    const bytes = await fs.readFile(f.abs);
    try {
      await graphUploadBytes(graph, opts, dest, bytes, guessContentType(f.abs));
      uploaded += 1;
    } catch (err) {
      warnings.push(`upload failed for ${f.rel}: ${(err as Error).message}`);
    }
  }
  return { kind: 'local', uploaded, warnings };
}

function guessContentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.html' || ext === '.htm') return 'text/html';
  if (ext === '.json') return 'application/json';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// SharePoint → File Sync record in Dataverse
// ---------------------------------------------------------------------------

async function wireSharePoint(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const warnings: string[] = [];
  if (!opts.dataverseUrl || !opts.agentRecordId) {
    warnings.push(
      'sharepoint kb requires dataverseUrl + agentRecordId to register the Copilot Studio Kit File Sync record',
    );
    return { kind: 'sharepoint', uploaded: 0, warnings };
  }
  const columns: FileSyncColumns = { ...DEFAULT_FILE_SYNC_COLUMNS, ...opts.fileSyncColumns };
  const entitySet = opts.fileSyncEntitySet ?? 'cat_filesynchronizations';
  const credential = getCredential({ mode: 'chained', tenantId: opts.tenantId });
  const dv = new DataverseClient({ envUrl: opts.dataverseUrl, credential });
  const payload: Record<string, unknown> = {
    [columns.agentId]: opts.agentRecordId,
    [columns.dataverseUrl]: opts.dataverseUrl,
    [columns.siteAddress]: opts.siteAddress ?? source.uri,
    [columns.libraryName]: opts.libraryName ?? 'Documents',
  };
  const folder = (source.options?.['folderPath'] as string | undefined) ?? undefined;
  if (folder) payload[columns.folderPath] = folder;
  const filter = (source.options?.['filter'] as string | undefined) ?? undefined;
  if (filter) payload[columns.filter] = filter;
  await dv.createRecord(entitySet, payload);
  return { kind: 'sharepoint', uploaded: 1, warnings };
}

// ---------------------------------------------------------------------------
// URL crawl → Markdown → SharePoint
// ---------------------------------------------------------------------------

async function uploadUrl(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const warnings: string[] = [];
  let chromium: unknown;
  try {
    const pw = (await import('playwright')) as unknown as { chromium: unknown };
    chromium = pw.chromium;
  } catch {
    warnings.push('playwright not installed — skipping URL crawl (run `pnpm add -w playwright`)');
    return { kind: 'url', uploaded: 0, warnings };
  }
  const seed = source.uri;
  const origin = new URL(seed).origin;
  const maxDepth = opts.maxDepth ?? 2;
  const maxPages = opts.maxPages ?? 25;
  const queue: { url: string; depth: number }[] = [{ url: seed, depth: 0 }];
  const seen = new Set<string>();
  const pages: { url: string; markdown: string }[] = [];
  const browser = await (chromium as { launch: (o?: Record<string, unknown>) => Promise<{
    newPage: () => Promise<{
      goto: (u: string, o?: Record<string, unknown>) => Promise<unknown>;
      content: () => Promise<string>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  }> }).launch({ headless: true });
  try {
    while (queue.length && pages.length < maxPages) {
      const item = queue.shift();
      if (!item) break;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      const page = await browser.newPage();
      try {
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        const html = await page.content();
        const markdown = htmlToMarkdown(html);
        pages.push({ url: item.url, markdown });
        if (item.depth < maxDepth) {
          for (const link of extractLinks(html, item.url)) {
            if (!seen.has(link) && new URL(link).origin === origin) {
              queue.push({ url: link, depth: item.depth + 1 });
            }
          }
        }
      } catch (err) {
        warnings.push(`crawl failed for ${item.url}: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (pages.length === 0) return { kind: 'url', uploaded: 0, warnings };
  const graph = await loadGraphClient(opts);
  const lib = opts.libraryName ?? 'AppFactoryKB';
  let uploaded = 0;
  for (const p of pages) {
    const name = `${sanitizeForFile(p.url)}.md`;
    try {
      await graphUploadBytes(graph, opts, `${lib}/crawl/${name}`, Buffer.from(p.markdown), 'text/markdown');
      uploaded += 1;
    } catch (err) {
      warnings.push(`upload failed for ${p.url}: ${(err as Error).message}`);
    }
  }
  return { kind: 'url', uploaded, warnings };
}

function extractLinks(html: string, base: string): string[] {
  const out: string[] = [];
  const rx = /<a\s+[^>]*href=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html))) {
    try {
      out.push(new URL(m[1] ?? '', base).toString());
    } catch {
      // skip malformed urls
    }
  }
  return out;
}

function htmlToMarkdown(html: string): string {
  // Strip script/style, drop tags, collapse whitespace. Pragmatic — not a full converter.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>(?=\s|$)/gi, '\n')
    .replace(/<\/?(h1|h2|h3|h4|h5|h6|p|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeForFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9-]+/g, '_').slice(0, 120) || 'page';
}

// ---------------------------------------------------------------------------
// GitHub → SharePoint
// ---------------------------------------------------------------------------

async function uploadGithub(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const warnings: string[] = [];
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kb-gh-'));
  let usedShellGit = false;
  try {
    try {
      const sg = (await import('simple-git')) as unknown as {
        simpleGit: () => { clone: (r: string, dest: string, args?: string[]) => Promise<unknown> };
      };
      await sg.simpleGit().clone(source.uri, tmpDir, ['--depth', '1']);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'simple-git clone failed; falling back to shell git via tmux');
      const handle = await spawn(
        `git clone --depth 1 ${shellQuote(source.uri)} ${shellQuote(tmpDir)}; echo GIT_DONE=$?`,
        { name: `kb-clone-${Date.now()}` },
      );
      try {
        const buf = await handle.waitFor(/GIT_DONE=(\d+)/, { timeoutMs: 10 * 60_000, pollMs: 2_000 });
        const code = Number.parseInt(/GIT_DONE=(\d+)/.exec(buf)?.[1] ?? '-1', 10);
        if (code !== 0) {
          warnings.push(`git clone failed (exit ${code})`);
          return { kind: 'github', uploaded: 0, warnings };
        }
        usedShellGit = true;
      } finally {
        await handle.kill().catch(() => undefined);
      }
    }
    const docs = await collectMarkdown(tmpDir);
    const graph = await loadGraphClient(opts);
    const lib = opts.libraryName ?? 'AppFactoryKB';
    let uploaded = 0;
    for (const f of docs) {
      const bytes = await fs.readFile(f.abs);
      try {
        await graphUploadBytes(graph, opts, `${lib}/github/${f.rel}`, bytes, 'text/markdown');
        uploaded += 1;
      } catch (err) {
        warnings.push(`upload failed for ${f.rel}: ${(err as Error).message}`);
      }
    }
    log.info({ uploaded, usedShellGit }, 'github kb uploaded');
    return { kind: 'github', uploaded, warnings };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function collectMarkdown(root: string): Promise<{ rel: string; abs: string }[]> {
  const all = await walkLocal(root);
  return all.filter((f) => {
    const lower = f.rel.toLowerCase();
    if (lower.startsWith('.git/')) return false;
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) return true;
    if (/(^|\/)readme(\.[^/]+)?$/.test(lower)) return true;
    if (lower.startsWith('docs/')) return true;
    return false;
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Stub connectors
// ---------------------------------------------------------------------------

function stubConnector(kind: KbSourceKind): KbUploadResult {
  log.warn({ kind }, 'connector pending — emitting zero-artifact stub');
  // TODO(aws-s3): wire @aws-sdk/client-s3 with credential resolution chain
  // TODO(gcp-gcs): wire @google-cloud/storage
  // TODO(foundry): wire AI Foundry datasets SDK
  // TODO(m365-admin): wire Microsoft Graph admin endpoints
  return {
    kind,
    uploaded: 0,
    warnings: [`${kind} connector pending — see TODO markers in kb-upload.ts`],
  };
}
