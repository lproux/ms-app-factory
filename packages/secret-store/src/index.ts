import { createLogger, type SecretRef } from '@app-factory/shared';

const log = createLogger('secret-store');

const SERVICE_PREFIX = 'app-factory';

type Keytar = typeof import('keytar');
type KvClient = import('@azure/keyvault-secrets').SecretClient;

let _keytar: Keytar | null | undefined;
async function loadKeytar(): Promise<Keytar | null> {
  if (_keytar !== undefined) return _keytar;
  try {
    _keytar = (await import('keytar')) as unknown as Keytar;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'keytar unavailable; falling back to in-memory store');
    _keytar = null;
  }
  return _keytar;
}

const memory = new Map<string, string>();
function memKey(scope: string, name: string) {
  return `${scope}::${name}`;
}

export interface KeyVaultAdapter {
  setSecret(name: string, value: string): Promise<void>;
  getSecret(name: string): Promise<string | null>;
}

export interface SecretStoreOptions {
  vault?: KeyVaultAdapter;
}

export class SecretStore {
  constructor(private readonly opts: SecretStoreOptions = {}) {}

  async set(scope: string, name: string, value: string): Promise<SecretRef> {
    const kt = await loadKeytar();
    if (kt) {
      await kt.setPassword(`${SERVICE_PREFIX}:${scope}`, name, value);
    } else {
      memory.set(memKey(scope, name), value);
    }
    if (this.opts.vault) {
      await this.opts.vault.setSecret(kvName(scope, name), value);
    }
    return { scope, name };
  }

  async get(scope: string, name: string): Promise<string | null> {
    const kt = await loadKeytar();
    if (kt) {
      const v = await kt.getPassword(`${SERVICE_PREFIX}:${scope}`, name);
      if (v) return v;
    } else {
      const v = memory.get(memKey(scope, name));
      if (v) return v;
    }
    if (this.opts.vault) {
      return this.opts.vault.getSecret(kvName(scope, name));
    }
    return null;
  }
}

function kvName(scope: string, name: string): string {
  return `${scope}-${name}`.replace(/[^A-Za-z0-9-]/g, '-');
}

export function azureKeyVaultAdapter(client: KvClient): KeyVaultAdapter {
  return {
    async setSecret(name, value) {
      await client.setSecret(name, value);
    },
    async getSecret(name) {
      try {
        const r = await client.getSecret(name);
        return r.value ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function buildPasteBundle(items: { scope: string; name: string; value: string; description?: string }[]): string {
  const lines = ['# App Factory — secrets bundle', '', '> Paste into Claude Code or `gh copilot` to wire these into a downstream config.', ''];
  for (const it of items) {
    lines.push(`## ${it.scope} / ${it.name}`);
    if (it.description) lines.push(it.description);
    lines.push('```');
    lines.push(it.value);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}
