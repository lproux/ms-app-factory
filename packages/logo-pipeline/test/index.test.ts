import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLogoSet } from '../src/index.js';
import { AppFactoryError } from '@app-factory/shared';

let sharpAvailable = true;
try {
  // sharp may not be installed in the workspace cache yet; the test will be skipped if so.
  await import('sharp');
} catch {
  sharpAvailable = false;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'sample.png');

describe('buildLogoSet', () => {
  it.skipIf(!sharpAvailable)('resizes the source to a 192px PNG and 32px outline', async () => {
    const set = await buildLogoSet({ sourcePath: fixture });
    expect(set.color192.width).toBe(192);
    expect(set.color192.height).toBe(192);
    // PNG magic header check (0x89 0x50 0x4E 0x47)
    expect(set.color192.bytes[0]).toBe(0x89);
    expect(set.color192.bytes[1]).toBe(0x50);
    expect(set.outline32.width).toBe(32);
    expect(set.outline32.bytes[0]).toBe(0x89);

    const sharp = (await import('sharp')).default as unknown as (b: Buffer) => {
      metadata(): Promise<{ width?: number; height?: number; format?: string }>;
    };
    const meta = await sharp(set.color192.bytes).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(192);
  });

  it('throws LOGO_MISSING when no source and provider=skip', async () => {
    let caught: AppFactoryError | undefined;
    try {
      await buildLogoSet({ provider: 'skip' });
    } catch (err) {
      caught = err as AppFactoryError;
    }
    expect(caught).toBeInstanceOf(AppFactoryError);
    expect(caught?.code).toBe('LOGO_MISSING');
    expect(caught?.recoverable).toBe(true);
  });

  it('verifies the fixture file is a real PNG (sanity check)', async () => {
    const bytes = await fs.readFile(fixture);
    expect(bytes[0]).toBe(0x89);
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');
  });
});
