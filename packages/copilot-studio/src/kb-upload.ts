import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';
import {
  AppFactoryError,
  AuthError,
  ProvisioningError,
  createLogger,
  type KbSource,
  type KbSourceKind,
} from '@app-factory/shared';
import { getCredential } from '@app-factory/auth-broker';
import { spawn } from '@app-factory/orchestrator';
import { withFallback } from '@app-factory/portal-automation';
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
      return uploadAwsS3(source, opts);
    case 'gcp-gcs':
      return uploadGcpGcs(source, opts);
    case 'foundry':
      return uploadFoundry(source, opts);
    case 'm365-admin':
      return uploadM365Admin(source, opts);
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
    get<T = unknown>(): Promise<T>;
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
// Document normalization (PDF/DOCX → Markdown)
// ---------------------------------------------------------------------------

/**
 * Convert PDF/DOCX bytes to markdown via mammoth (DOCX) and pdf-parse (PDF).
 * Falls back to the raw bytes if the extension is anything else.
 *
 * Returns the normalized bytes plus the destination content-type and
 * the rewritten relative path (e.g. `report.pdf` -> `report.pdf.md`).
 */
async function normalizeDoc(
  relPath: string,
  bytes: Buffer,
): Promise<{ rel: string; bytes: Buffer; contentType: string }> {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.pdf') {
    try {
      const mod = (await import('pdf-parse')) as unknown as {
        default?: (b: Buffer) => Promise<{ text: string }>;
      } & ((b: Buffer) => Promise<{ text: string }>);
      const fn = mod.default ?? (mod as unknown as (b: Buffer) => Promise<{ text: string }>);
      const parsed = await fn(bytes);
      const md = (parsed.text ?? '').trim();
      return { rel: `${relPath}.md`, bytes: Buffer.from(md, 'utf8'), contentType: 'text/markdown' };
    } catch (err) {
      log.warn({ rel: relPath, err: (err as Error).message }, 'pdf-parse failed; uploading raw bytes');
      return { rel: relPath, bytes, contentType: 'application/pdf' };
    }
  }
  if (ext === '.docx') {
    try {
      const mammoth = (await import('mammoth')) as unknown as {
        convertToHtml: (i: { buffer: Buffer }) => Promise<{ value: string }>;
      };
      const html = await mammoth.convertToHtml({ buffer: bytes });
      const md = htmlToMarkdown(html.value ?? '');
      return { rel: `${relPath}.md`, bytes: Buffer.from(md, 'utf8'), contentType: 'text/markdown' };
    } catch (err) {
      log.warn({ rel: relPath, err: (err as Error).message }, 'mammoth failed; uploading raw bytes');
      return { rel: relPath, bytes, contentType: guessContentType(relPath) };
    }
  }
  return { rel: relPath, bytes, contentType: guessContentType(relPath) };
}

// ---------------------------------------------------------------------------
// AWS S3 → SharePoint
// ---------------------------------------------------------------------------

interface S3UriParts {
  bucket: string;
  prefix: string;
}

function parseS3Uri(uri: string): S3UriParts {
  // Accept `s3://bucket/prefix/...` or `bucket/prefix/...`.
  const stripped = uri.startsWith('s3://') ? uri.slice(5) : uri;
  const slash = stripped.indexOf('/');
  if (slash < 0) return { bucket: stripped, prefix: '' };
  return { bucket: stripped.slice(0, slash), prefix: stripped.slice(slash + 1) };
}

async function uploadAwsS3(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const s3log = createLogger('kb-upload:aws-s3');
  const warnings: string[] = [];
  const { bucket, prefix } = parseS3Uri(source.uri);
  if (!bucket) {
    throw new AppFactoryError('KB_S3_BAD_URI', `invalid s3 uri: ${source.uri}`);
  }
  const profile = (source.options?.['profile'] as string | undefined) ?? process.env.AWS_PROFILE;
  const region =
    (source.options?.['region'] as string | undefined) ??
    process.env.AWS_REGION ??
    process.env.AWS_DEFAULT_REGION ??
    'us-east-1';

  let s3Mod: typeof import('@aws-sdk/client-s3');
  let credMod: typeof import('@aws-sdk/credential-providers');
  try {
    s3Mod = (await import('@aws-sdk/client-s3')) as unknown as typeof import('@aws-sdk/client-s3');
    credMod = (await import(
      '@aws-sdk/credential-providers'
    )) as unknown as typeof import('@aws-sdk/credential-providers');
  } catch (err) {
    throw new ProvisioningError(
      `aws-s3 connector requires @aws-sdk/client-s3 + @aws-sdk/credential-providers: ${(err as Error).message}`,
      { cause: err },
    );
  }

  // Per acceptance criteria: prefer `fromIni()` with env-var fallback.
  // `fromEnv()` reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.
  const hasEnvCreds = Boolean(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
  const credentials = hasEnvCreds ? credMod.fromEnv() : credMod.fromIni({ profile });

  const client = new s3Mod.S3Client({ region, credentials });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-kb-s3-'));
  s3log.info({ bucket, prefix, region, tmpDir }, 'cloning s3 prefix');

  const downloaded: { rel: string; abs: string }[] = [];
  try {
    let continuationToken: string | undefined;
    do {
      const sendClient = client as unknown as { send(cmd: unknown): Promise<unknown> };
      const raw = await sendClient
        .send(
          new s3Mod.ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix || undefined,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          }),
        )
        .catch((err: unknown) => {
          const code = (err as { name?: string; Code?: string }).name ?? (err as { Code?: string }).Code;
          if (code === 'CredentialsProviderError' || code === 'CredentialsError' || code === 'AccessDenied') {
            throw new AuthError(`aws-s3 auth failed: ${(err as Error).message}`, { cause: err });
          }
          throw new ProvisioningError(`s3 list failed: ${(err as Error).message}`, { cause: err });
        });
      const listOut = raw as {
        Contents?: Array<{ Key?: string; Size?: number }>;
        IsTruncated?: boolean;
        NextContinuationToken?: string;
      };
      const contents = listOut.Contents ?? [];
      for (const obj of contents) {
        const key = obj.Key;
        if (!key || key.endsWith('/')) continue;
        const rel = prefix && key.startsWith(prefix) ? key.slice(prefix.length).replace(/^\/+/, '') : key;
        if (!rel) continue;
        const dest = path.join(tmpDir, rel);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        const rawGet = await sendClient
          .send(new s3Mod.GetObjectCommand({ Bucket: bucket, Key: key }))
          .catch((err: unknown) => {
            warnings.push(`s3 get ${key} failed: ${(err as Error).message}`);
            return undefined;
          });
        const got = rawGet as { Body?: { transformToByteArray(): Promise<Uint8Array> } } | undefined;
        if (!got?.Body) continue;
        const bytes = await got.Body.transformToByteArray();
        await fs.writeFile(dest, Buffer.from(bytes));
        downloaded.push({ rel, abs: dest });
      }
      continuationToken = listOut.IsTruncated ? listOut.NextContinuationToken : undefined;
    } while (continuationToken);

    if (downloaded.length === 0) {
      warnings.push(`no objects found at s3://${bucket}/${prefix}`);
      return { kind: 'aws-s3', uploaded: 0, warnings };
    }

    const graph = await loadGraphClient(opts);
    const lib = opts.libraryName ?? 'AppFactoryKB';
    let uploaded = 0;
    for (const f of downloaded) {
      const bytes = await fs.readFile(f.abs);
      const norm = await normalizeDoc(f.rel, bytes);
      try {
        await graphUploadBytes(
          graph,
          opts,
          `${lib}/aws-s3/${norm.rel}`,
          norm.bytes,
          norm.contentType,
        );
        uploaded += 1;
      } catch (err) {
        warnings.push(`upload failed for ${f.rel}: ${(err as Error).message}`);
      }
    }
    s3log.info({ uploaded, bucket, prefix }, 'aws-s3 kb uploaded');
    return { kind: 'aws-s3', uploaded, warnings };
  } finally {
    client.destroy();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Google Cloud Storage → SharePoint
// ---------------------------------------------------------------------------

interface GcsUriParts {
  bucket: string;
  prefix: string;
}

function parseGcsUri(uri: string): GcsUriParts {
  const stripped = uri.startsWith('gs://') ? uri.slice(5) : uri;
  const slash = stripped.indexOf('/');
  if (slash < 0) return { bucket: stripped, prefix: '' };
  return { bucket: stripped.slice(0, slash), prefix: stripped.slice(slash + 1) };
}

async function uploadGcpGcs(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const gcsLog = createLogger('kb-upload:gcp-gcs');
  const warnings: string[] = [];
  const { bucket, prefix } = parseGcsUri(source.uri);
  if (!bucket) {
    throw new AppFactoryError('KB_GCS_BAD_URI', `invalid gs uri: ${source.uri}`);
  }

  let storageMod: typeof import('@google-cloud/storage');
  try {
    storageMod = (await import(
      '@google-cloud/storage'
    )) as unknown as typeof import('@google-cloud/storage');
  } catch (err) {
    throw new ProvisioningError(
      `gcp-gcs connector requires @google-cloud/storage: ${(err as Error).message}`,
      { cause: err },
    );
  }

  // Auth: ADC by default; `GOOGLE_APPLICATION_CREDENTIALS` env points at a JSON keyfile.
  const projectId =
    (source.options?.['projectId'] as string | undefined) ??
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT;
  const keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const storage = new storageMod.Storage({ projectId, keyFilename });

  gcsLog.info({ bucket, prefix, projectId, keyFilename: Boolean(keyFilename) }, 'listing gcs objects');
  const gcsBucket = storage.bucket(bucket);

  let files: { name: string; download: () => Promise<[Buffer]> }[];
  try {
    const [list] = await gcsBucket.getFiles({ prefix: prefix || undefined, autoPaginate: true });
    files = list;
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/Could not load the default credentials/i.test(msg) || /unauthenticated/i.test(msg) || /invalid_grant/i.test(msg)) {
      throw new AuthError(`gcp-gcs auth failed: ${msg}`, { cause: err });
    }
    throw new ProvisioningError(`gcs list failed: ${msg}`, { cause: err });
  }

  if (files.length === 0) {
    warnings.push(`no objects found at gs://${bucket}/${prefix}`);
    return { kind: 'gcp-gcs', uploaded: 0, warnings };
  }

  const graph = await loadGraphClient(opts);
  const lib = opts.libraryName ?? 'AppFactoryKB';
  let uploaded = 0;
  for (const f of files) {
    if (f.name.endsWith('/')) continue;
    const rel = prefix && f.name.startsWith(prefix) ? f.name.slice(prefix.length).replace(/^\/+/, '') : f.name;
    if (!rel) continue;
    let bytes: Buffer;
    try {
      const [buf] = await f.download();
      bytes = buf;
    } catch (err) {
      warnings.push(`gcs download ${f.name} failed: ${(err as Error).message}`);
      continue;
    }
    const norm = await normalizeDoc(rel, bytes);
    try {
      await graphUploadBytes(graph, opts, `${lib}/gcp-gcs/${norm.rel}`, norm.bytes, norm.contentType);
      uploaded += 1;
    } catch (err) {
      warnings.push(`upload failed for ${rel}: ${(err as Error).message}`);
    }
  }

  gcsLog.info({ uploaded, bucket, prefix }, 'gcp-gcs kb uploaded');
  return { kind: 'gcp-gcs', uploaded, warnings };
}

// ---------------------------------------------------------------------------
// Azure AI Foundry dataset → SharePoint
// ---------------------------------------------------------------------------

interface FoundryFile {
  name: string;
  url?: string;
  size?: number;
}

interface FoundryListResponse {
  value?: FoundryFile[];
  nextLink?: string;
}

async function foundryGet<T>(
  url: string,
  token: string,
): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`foundry GET ${url} → ${res.status}`);
    }
    throw new ProvisioningError(`foundry GET ${url} → ${res.status}`);
  }
  return (await res.json()) as T;
}

async function uploadFoundry(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const fLog = createLogger('kb-upload:foundry');
  const warnings: string[] = [];
  const projectId = source.options?.['projectId'] as string | undefined;
  const datasetId = (source.options?.['datasetId'] as string | undefined) ?? source.uri;
  if (!projectId || !datasetId) {
    throw new AppFactoryError(
      'KB_FOUNDRY_TARGETING',
      'foundry connector requires KbSource.options.projectId + datasetId',
    );
  }

  // Acquire token via ADC chain.
  const credential = getCredential({ mode: 'chained', tenantId: opts.tenantId });
  const scope = 'https://ai.azure.com/.default';

  return withFallback({
    label: 'foundry-dataset-ingest',
    primary: async () => {
      const tokRes = await credential.getToken(scope).catch((err: unknown) => {
        throw new AuthError(`foundry token acquisition failed: ${(err as Error).message}`, { cause: err });
      });
      if (!tokRes) throw new AuthError('foundry token acquisition returned null');
      const token = tokRes.token;

      const base = `https://ai.azure.com/api/projects/${encodeURIComponent(projectId)}/datasets/${encodeURIComponent(datasetId)}`;
      fLog.info({ base }, 'listing foundry dataset files');

      const files: FoundryFile[] = [];
      let nextUrl: string | undefined = `${base}/files`;
      while (nextUrl) {
        const page: FoundryListResponse = await foundryGet<FoundryListResponse>(nextUrl, token);
        for (const f of page.value ?? []) {
          if (f.name) files.push(f);
        }
        nextUrl = page.nextLink;
      }

      if (files.length === 0) {
        warnings.push(`no files found in foundry dataset ${projectId}/${datasetId}`);
        return { kind: 'foundry' as KbSourceKind, uploaded: 0, warnings };
      }

      const graph = await loadGraphClient(opts);
      const lib = opts.libraryName ?? 'AppFactoryKB';
      let uploaded = 0;

      for (const f of files) {
        const fileUrl = f.url ?? `${base}/files/${encodeURIComponent(f.name)}/content`;
        const res = await fetch(fileUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          warnings.push(`foundry fetch ${f.name} → ${res.status}`);
          continue;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const norm = await normalizeDoc(f.name, buf);
        try {
          await graphUploadBytes(graph, opts, `${lib}/foundry/${norm.rel}`, norm.bytes, norm.contentType);
          uploaded += 1;
        } catch (err) {
          warnings.push(`upload failed for ${f.name}: ${(err as Error).message}`);
        }
      }

      fLog.info({ uploaded, projectId, datasetId }, 'foundry kb uploaded');
      return { kind: 'foundry' as KbSourceKind, uploaded, warnings };
    },
  });
}

// ---------------------------------------------------------------------------
// Microsoft 365 admin (Graph) → SharePoint
// ---------------------------------------------------------------------------

interface GraphServiceMessage {
  id: string;
  title?: string;
  body?: { content?: string };
  category?: string;
  severity?: string;
  startDateTime?: string;
}

async function uploadM365Admin(source: KbSource, opts: KbDispatchOptions): Promise<KbUploadResult> {
  const mLog = createLogger('kb-upload:m365-admin');
  const warnings: string[] = [];
  const report =
    (source.options?.['report'] as string | undefined) ??
    (source.uri && source.uri !== 'noop' ? source.uri : 'serviceAnnouncement/messages');

  const graph = await loadGraphClient(opts).catch((err: unknown) => {
    throw new AuthError(`m365-admin graph init failed: ${(err as Error).message}`, { cause: err });
  });
  const lib = opts.libraryName ?? 'AppFactoryKB';
  let uploaded = 0;

  // Service announcement messages route: structured JSON + markdown summary.
  if (report === 'serviceAnnouncement/messages' || report.startsWith('admin/serviceAnnouncement')) {
    const apiPath = '/admin/serviceAnnouncement/messages';
    let res: { value?: GraphServiceMessage[] };
    try {
      res = await graph.api(apiPath).get<{ value?: GraphServiceMessage[] }>();
    } catch (err) {
      const msg = (err as { statusCode?: number; message?: string }).message ?? String(err);
      if (/401|403|Authorization|unauthor/i.test(msg)) {
        throw new AuthError(`m365-admin auth failed: ${msg}`, { cause: err });
      }
      throw new ProvisioningError(`m365-admin list failed: ${msg}`, { cause: err });
    }
    const messages = res.value ?? [];
    for (const m of messages) {
      const baseName = `${m.id}-${sanitizeForFile(m.title ?? 'message')}`;
      const md = [
        `# ${m.title ?? m.id}`,
        '',
        `- id: ${m.id}`,
        `- category: ${m.category ?? ''}`,
        `- severity: ${m.severity ?? ''}`,
        `- startDateTime: ${m.startDateTime ?? ''}`,
        '',
        htmlToMarkdown(m.body?.content ?? ''),
      ].join('\n');
      try {
        await graphUploadBytes(
          graph,
          opts,
          `${lib}/m365-admin/${baseName}.md`,
          Buffer.from(md, 'utf8'),
          'text/markdown',
        );
        uploaded += 1;
      } catch (err) {
        warnings.push(`upload failed for ${m.id}: ${(err as Error).message}`);
      }
    }
    mLog.info({ uploaded, count: messages.length }, 'm365 service messages uploaded');
    return { kind: 'm365-admin', uploaded, warnings };
  }

  // Reports route: dump CSV/JSON for the requested report.
  // The `/reports/<id>` graph segment returns a CSV by default for most usage reports.
  const reportPath = report.startsWith('/') ? report : `/reports/${report}`;
  try {
    const blob = await graph.api(reportPath).get<unknown>();
    const text = typeof blob === 'string' ? blob : JSON.stringify(blob, null, 2);
    const name = `${sanitizeForFile(report)}.${typeof blob === 'string' ? 'csv' : 'json'}`;
    const contentType = typeof blob === 'string' ? 'text/csv' : 'application/json';
    await graphUploadBytes(graph, opts, `${lib}/m365-admin/${name}`, Buffer.from(text, 'utf8'), contentType);
    uploaded += 1;
  } catch (err) {
    const msg = (err as Error).message;
    if (/401|403|Authorization|unauthor/i.test(msg)) {
      throw new AuthError(`m365-admin auth failed: ${msg}`, { cause: err });
    }
    warnings.push(`m365 report ${report} failed: ${msg}`);
  }

  return { kind: 'm365-admin', uploaded, warnings };
}
