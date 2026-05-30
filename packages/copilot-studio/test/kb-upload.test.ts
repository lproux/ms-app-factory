import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const graphPutMock = vi.fn().mockResolvedValue({});
const graphPostMock = vi.fn().mockResolvedValue({});

vi.mock('@microsoft/microsoft-graph-client', () => {
  const apiBuilder = () => ({
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

import { uploadKb } from '../src/kb-upload.js';

describe('uploadKb stub connectors', () => {
  it('warns and returns zero artifacts for aws-s3', async () => {
    const r = await uploadKb({ kind: 'aws-s3', uri: 's3://bucket/x' }, {});
    expect(r.uploaded).toBe(0);
    expect(r.warnings.some((w) => w.includes('aws-s3'))).toBe(true);
  });

  it('warns for gcp-gcs, foundry, m365-admin without throwing', async () => {
    for (const kind of ['gcp-gcs', 'foundry', 'm365-admin'] as const) {
      const r = await uploadKb({ kind, uri: 'noop' }, {});
      expect(r.uploaded).toBe(0);
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe('uploadKb local dispatch', () => {
  it('uploads each file via the graph drive path', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-kb-local-'));
    try {
      await fs.writeFile(path.join(tmp, 'a.md'), '# hello');
      await fs.mkdir(path.join(tmp, 'sub'));
      await fs.writeFile(path.join(tmp, 'sub', 'b.txt'), 'world');

      graphPutMock.mockClear();
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
