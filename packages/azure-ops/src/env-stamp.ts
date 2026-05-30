import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createLogger } from '@app-factory/shared';

const log = createLogger('azure-ops:env-stamp');

/**
 * Merge `vars` into a dotenv-style file, preserving comments and the existing
 * key order. Existing keys are overwritten; new keys are appended at the end.
 */
export async function stampEnvFile(envPath: string, vars: Record<string, string>): Promise<void> {
  await mkdir(dirname(envPath), { recursive: true });

  let lines: string[] = [];
  if (existsSync(envPath)) {
    const raw = await readFile(envPath, 'utf8');
    lines = raw.split(/\r?\n/);
  }

  const wanted = new Map(Object.entries(vars));
  const seen = new Set<string>();

  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (wanted.has(key)) {
      out.push(`${key}=${formatValue(wanted.get(key) ?? '')}`);
      seen.add(key);
    } else {
      out.push(line);
    }
  }

  const appended: string[] = [];
  for (const [k, v] of wanted) {
    if (!seen.has(k)) {
      appended.push(`${k}=${formatValue(v)}`);
    }
  }

  if (appended.length > 0) {
    if (out.length > 0 && out[out.length - 1] !== '') {
      out.push('');
    }
    out.push(...appended);
  }

  if (out.length === 0 || out[out.length - 1] !== '') {
    out.push('');
  }

  await writeFile(envPath, out.join('\n'), 'utf8');
  log.info({ envPath, keys: Array.from(wanted.keys()) }, 'env file stamped');
}

function formatValue(v: string): string {
  if (v === '') return '';
  if (/[\s#'"]/.test(v)) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return v;
}
