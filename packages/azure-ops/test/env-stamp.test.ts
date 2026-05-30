import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stampEnvFile } from '../src/env-stamp.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(process.cwd(), '.env-stamp-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('stampEnvFile', () => {
  it('creates a new .env file when none exists', async () => {
    const p = join(dir, '.env.dev');
    await stampEnvFile(p, { FOO: 'bar', BAZ: 'qux' });
    const txt = await readFile(p, 'utf8');
    expect(txt).toContain('FOO=bar');
    expect(txt).toContain('BAZ=qux');
  });

  it('overwrites existing keys while preserving comments + order', async () => {
    const p = join(dir, '.env.dev');
    await writeFile(p, '# header comment\nFOO=old\n# inline\nBAZ=keep\n', 'utf8');
    await stampEnvFile(p, { FOO: 'new', NEW_KEY: 'extra' });
    const txt = await readFile(p, 'utf8');
    const lines = txt.split('\n');
    expect(lines[0]).toBe('# header comment');
    expect(lines[1]).toBe('FOO=new');
    expect(lines[2]).toBe('# inline');
    expect(lines[3]).toBe('BAZ=keep');
    expect(txt).toContain('NEW_KEY=extra');
  });

  it('quotes values containing spaces or specials', async () => {
    const p = join(dir, '.env.dev');
    await stampEnvFile(p, { MSG: 'hello world', PATH_LIKE: 'a"b' });
    const txt = await readFile(p, 'utf8');
    expect(txt).toContain('MSG="hello world"');
    expect(txt).toContain('PATH_LIKE="a\\"b"');
  });

  it('is idempotent across two writes with same vars', async () => {
    const p = join(dir, '.env.dev');
    await stampEnvFile(p, { A: '1', B: '2' });
    const first = await readFile(p, 'utf8');
    await stampEnvFile(p, { A: '1', B: '2' });
    const second = await readFile(p, 'utf8');
    expect(second).toBe(first);
  });
});
