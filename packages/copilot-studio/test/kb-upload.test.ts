import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const graphPutMock = vi.fn().mockResolvedValue({});
const graphPostMock = vi.fn().mockResolvedValue({});
const graphGetMock = vi.fn().mockResolvedValue({ value: [] });

vi.mock('@microsoft/microsoft-graph-client', () => {
  const apiBuilder = () => ({
    get: graphGetMock,
    put: graphPutMock,
    post: graphPostMock,
    headers: () => ({ put: graphPutMock }),
  });
  return {
    Client: {
      initWithMiddleware: () => ({ api: apiBuilder }),
    },
  };
});

vi.mock('isomorphic-fetch', () => ({}));

vi.mock('@app-factory/auth-broker', () => ({
  getCredential: () => ({
    getToken: async () => ({ token: 'fake', expiresOnTimestamp: Date.now() + 60_000 }),
  }),
}));

// AWS SDK mocks ----------------------------------------------------------------
const s3SendMock = vi.fn();
const s3DestroyMock = vi.fn();
vi.mock('@aws-sdk/client-s3', () => {
  class ListObjectsV2Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class GetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class S3Client {
    constructor(_cfg?: unknown) {}
    send(cmd: unknown) {
      return s3SendMock(cmd);
    }
    destroy() {
      s3DestroyMock();
    }
  }
  return { ListObjectsV2Command, GetObjectCommand, S3Client };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: () => ({ kind: 'ini' }),
  fromEnv: () => ({ kind: 'env' }),
  fromNodeProviderChain: () => ({ kind: 'chain' }),
}));

// GCS SDK mocks ----------------------------------------------------------------
const gcsGetFilesMock = vi.fn();
const gcsDownloadMock = vi.fn();
vi.mock('@google-cloud/storage', () => {
  class Storage {
    constructor(_o?: unknown) {}
    bucket(_name: string) {
      return {
        getFiles: (...args: unknown[]) => gcsGetFilesMock(...args),
      };
    }
  }
  return { Storage };
});

// pdf-parse + mammoth mocks ---------------------------------------------------
vi.mock('pdf-parse', () => ({
  default: async () => ({ text: 'pdf body text' }),
}));
vi.mock('mammoth', () => ({
  convertToHtml: async () => ({ value: '<h1>docx body</h1>' }),
  extractRawText: async () => ({ value: 'docx body' }),
}));

// portal-automation: pass-through (no fallback configured)
vi.mock('@app-factory/portal-automation', () => ({
  withFallback: async <T>(o: { primary: () => Promise<T> }) => o.primary(),
}));

// Fetch shim (Foundry path uses global fetch).
const fetchMock = vi.fn();
beforeEach(() => {
  s3SendMock.mockReset();
  s3DestroyMock.mockReset();
  gcsGetFilesMock.mockReset();
  gcsDownloadMock.mockReset();
  graphPutMock.mockClear();
  graphPostMock.mockClear();
  graphGetMock.mockReset().mockResolvedValue({ value: [] });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

import { uploadKb } from '../src/kb-upload.js';

// -----------------------------------------------------------------------------
// local dispatch (preserved smoke test)
// -----------------------------------------------------------------------------

describe('uploadKb local dispatch', () => {
  it('uploads each file via the graph drive path', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-kb-local-'));
    try {
      await fs.writeFile(path.join(tmp, 'a.md'), '# hello');
      await fs.mkdir(path.join(tmp, 'sub'));
      await fs.writeFile(path.join(tmp, 'sub', 'b.txt'), 'world');

      const r = await uploadKb(
        { kind: 'local', uri: tmp },
        { driveId: 'drive-1', libraryName: 'KB' },
      );
      expect(r.uploaded).toBe(2);
      expect(graphPutMock).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

// -----------------------------------------------------------------------------
// AWS S3
// -----------------------------------------------------------------------------

describe('uploadKb aws-s3 connector', () => {
  it('happy path: lists bucket prefix, downloads, normalizes, and uploads', async () => {
    s3SendMock.mockImplementation(async (cmd: unknown) => {
      const klass = (cmd as { constructor: { name: string } }).constructor.name;
      if (klass === 'ListObjectsV2Command') {
        return {
          Contents: [
            { Key: 'docs/intro.md', Size: 8 },
            { Key: 'docs/report.pdf', Size: 16 },
            { Key: 'docs/subdir/', Size: 0 }, // directory marker — should be skipped
          ],
          IsTruncated: false,
        };
      }
      if (klass === 'GetObjectCommand') {
        const key = (cmd as { input: { Key: string } }).input.Key;
        const body = Buffer.from(key === 'docs/intro.md' ? '# intro' : 'pdf raw');
        return {
          Body: { transformToByteArray: async () => new Uint8Array(body) },
        };
      }
      throw new Error(`unexpected command ${klass}`);
    });

    const r = await uploadKb(
      { kind: 'aws-s3', uri: 's3://my-bucket/docs/' },
      { driveId: 'drv', libraryName: 'KB' },
    );
    expect(r.kind).toBe('aws-s3');
    expect(r.uploaded).toBe(2);
    expect(graphPutMock).toHaveBeenCalledTimes(2);
    expect(s3DestroyMock).toHaveBeenCalled();
  });

  it('auth-fail path: surfaces CredentialsProviderError as AuthError', async () => {
    s3SendMock.mockImplementation(async () => {
      const err = new Error('no credentials') as Error & { name: string };
      err.name = 'CredentialsProviderError';
      throw err;
    });
    const r = uploadKb({ kind: 'aws-s3', uri: 's3://b/p' }, { driveId: 'd' });
    await expect(r).rejects.toMatchObject({ name: 'AuthError' });
  });
});

// -----------------------------------------------------------------------------
// GCP GCS
// -----------------------------------------------------------------------------

describe('uploadKb gcp-gcs connector', () => {
  it('happy path: lists bucket prefix, downloads, uploads', async () => {
    gcsGetFilesMock.mockResolvedValue([
      [
        {
          name: 'docs/a.md',
          download: async () => [Buffer.from('# hello')],
        },
        {
          name: 'docs/b.txt',
          download: async () => [Buffer.from('plain text')],
        },
      ],
      undefined,
      undefined,
    ]);

    const r = await uploadKb(
      { kind: 'gcp-gcs', uri: 'gs://my-bucket/docs/' },
      { driveId: 'drv' },
    );
    expect(r.kind).toBe('gcp-gcs');
    expect(r.uploaded).toBe(2);
    expect(graphPutMock).toHaveBeenCalledTimes(2);
  });

  it('auth-fail path: ADC missing → AuthError', async () => {
    gcsGetFilesMock.mockRejectedValue(
      new Error('Could not load the default credentials. Browse to https://...'),
    );
    const r = uploadKb({ kind: 'gcp-gcs', uri: 'gs://b/p' }, { driveId: 'd' });
    await expect(r).rejects.toMatchObject({ name: 'AuthError' });
  });
});

// -----------------------------------------------------------------------------
// Azure AI Foundry
// -----------------------------------------------------------------------------

describe('uploadKb foundry connector', () => {
  it('happy path: pulls dataset files via REST and uploads', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('/files')) {
        return new Response(
          JSON.stringify({
            value: [{ name: 'spec.md' }, { name: 'data.txt' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('contents here', { status: 200 });
    });
    const r = await uploadKb(
      { kind: 'foundry', uri: 'unused', options: { projectId: 'proj', datasetId: 'ds' } },
      { driveId: 'drv' },
    );
    expect(r.kind).toBe('foundry');
    expect(r.uploaded).toBe(2);
    expect(graphPutMock).toHaveBeenCalledTimes(2);
  });

  it('auth-fail path: 401 from foundry REST surfaces as AuthError', async () => {
    fetchMock.mockResolvedValue(new Response('forbidden', { status: 401 }));
    const r = uploadKb(
      { kind: 'foundry', uri: 'unused', options: { projectId: 'p', datasetId: 'd' } },
      { driveId: 'drv' },
    );
    await expect(r).rejects.toMatchObject({ name: 'AuthError' });
  });
});

// -----------------------------------------------------------------------------
// M365 admin
// -----------------------------------------------------------------------------

describe('uploadKb m365-admin connector', () => {
  it('happy path: lists service announcement messages and uploads markdown', async () => {
    graphGetMock.mockResolvedValueOnce({
      value: [
        {
          id: 'MC123',
          title: 'Service maintenance',
          severity: 'normal',
          category: 'planForChange',
          body: { content: '<p>Hello <b>world</b></p>' },
          startDateTime: '2026-05-30T00:00:00Z',
        },
        {
          id: 'MC124',
          title: 'Another',
          body: { content: 'plain body' },
        },
      ],
    });
    const r = await uploadKb({ kind: 'm365-admin', uri: 'serviceAnnouncement/messages' }, { driveId: 'drv' });
    expect(r.kind).toBe('m365-admin');
    expect(r.uploaded).toBe(2);
    expect(graphPutMock).toHaveBeenCalledTimes(2);
  });

  it('auth-fail path: Graph 401 surfaces as AuthError', async () => {
    graphGetMock.mockRejectedValueOnce(
      Object.assign(new Error('Unauthorized - 401'), { statusCode: 401 }),
    );
    const r = uploadKb({ kind: 'm365-admin', uri: 'serviceAnnouncement/messages' }, { driveId: 'drv' });
    await expect(r).rejects.toMatchObject({ name: 'AuthError' });
  });
});
