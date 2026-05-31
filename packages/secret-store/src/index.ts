import { AppFactoryError, createLogger, type SecretRef } from '@app-factory/shared';

const log = createLogger('secret-store');

const SERVICE_PREFIX = 'app-factory';

/**
 * Minimal structural type for the `@napi-rs/keyring` `Entry` constructor. We
 * keep the contract narrow so the in-tree mock in tests can satisfy it
 * without pulling in the native binary.
 */
type KeyringEntryCtor = new (
  service: string,
  account: string,
) => {
  setPassword(value: string): void | Promise<void>;
  getPassword(): string | null | Promise<string | null>;
};

type KeyringModule = { Entry: KeyringEntryCtor };

let _keyring: KeyringModule | null | undefined;
async function loadKeyring(): Promise<KeyringModule | null> {
  if (_keyring !== undefined) return _keyring;
  try {
    _keyring = (await import('@napi-rs/keyring')) as unknown as KeyringModule;
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      '@napi-rs/keyring failed to load; OS keyring unavailable',
    );
    _keyring = null;
  }
  return _keyring;
}

const memory = new Map<string, string>();
function memKey(scope: string, name: string) {
  return `${scope}::${name}`;
}

function memoryFallbackAllowed(): boolean {
  return process.env['APP_FACTORY_ALLOW_MEMORY_SECRETS'] === '1';
}

function unavailable(cause: unknown): AppFactoryError {
  return new AppFactoryError(
    'SECRET_STORE_UNAVAILABLE',
    'OS keyring is unavailable. Install platform deps (e.g. libsecret-1-dev on Debian/Ubuntu) or set APP_FACTORY_ALLOW_MEMORY_SECRETS=1 to use the ephemeral in-memory fallback.',
    { recoverable: true, cause },
  );
}

/**
 * Try the OS keyring via `@napi-rs/keyring`. Returns the keyring result on
 * success. When the backend is missing or throws:
 *   - if `APP_FACTORY_ALLOW_MEMORY_SECRETS=1`, fall back to the in-memory
 *     callback;
 *   - else if `mode === 'soft'`, swallow the throw and return the memory
 *     fallback's value anyway (used by `get` so missing entries don't
 *     hard-fail);
 *   - else throw `AppFactoryError('SECRET_STORE_UNAVAILABLE')` (used by
 *     `set` — silent in-memory persistence is the worst-of-both-worlds).
 */
async function withKeyring<T>(
  op: (mod: KeyringModule) => Promise<T> | T,
  memoryFallback: () => T,
  mode: 'strict' | 'soft' = 'strict',
): Promise<T> {
  const mod = await loadKeyring();
  if (mod) {
    try {
      return await op(mod);
    } catch (err) {
      if (memoryFallbackAllowed()) {
        log.warn(
          { err: (err as Error).message },
          'keyring op threw; falling back to in-memory store (APP_FACTORY_ALLOW_MEMORY_SECRETS=1)',
        );
        return memoryFallback();
      }
      if (mode === 'soft') {
        // `get` path: a throw here usually means "no such entry" — the
        // keyring is reachable, the credential just doesn't exist. We
        // therefore return whatever the memory fallback would return
        // (typically `null`) rather than escalating to an error.
        log.debug(
          { err: (err as Error).message },
          'keyring lookup threw (likely no-entry); returning memory-fallback value',
        );
        return memoryFallback();
      }
      throw unavailable(err);
    }
  }
  if (memoryFallbackAllowed()) {
    log.warn('keyring module missing; using in-memory store (APP_FACTORY_ALLOW_MEMORY_SECRETS=1)');
    return memoryFallback();
  }
  if (mode === 'soft') {
    return memoryFallback();
  }
  throw unavailable(new Error('@napi-rs/keyring not loadable'));
}

type KvClient = import('@azure/keyvault-secrets').SecretClient;

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
    await withKeyring(
      async (mod) => {
        const entry = new mod.Entry(`${SERVICE_PREFIX}:${scope}`, name);
        await entry.setPassword(value);
      },
      () => {
        memory.set(memKey(scope, name), value);
      },
    );
    if (this.opts.vault) {
      await this.opts.vault.setSecret(kvName(scope, name), value);
    }
    return { scope, name };
  }

  async get(scope: string, name: string): Promise<string | null> {
    // Use `soft` mode: a missing entry causes `@napi-rs/keyring` to throw a
    // `NoEntry` error rather than returning null, but from the caller's
    // perspective "not found" and "found nothing" should be identical.
    // `withKeyring` will surface either the keyring value or the memory
    // fallback's value, so we fall through to Key Vault on null.
    const local = await withKeyring(
      async (mod) => {
        const entry = new mod.Entry(`${SERVICE_PREFIX}:${scope}`, name);
        const v = await entry.getPassword();
        return v ?? null;
      },
      () => memory.get(memKey(scope, name)) ?? null,
      'soft',
    );
    if (local) return local;
    if (this.opts.vault) {
      return this.opts.vault.getSecret(kvName(scope, name));
    }
    return null;
  }
}

function kvName(scope: string, name: string): string {
  return `${scope}-${name}`.replace(/[^A-Za-z0-9-]/g, '-');
}

export interface BuildSecretStoreOptions {
  keyVaultUrl?: string;
  credential?: import('@azure/identity').TokenCredential;
}

export async function buildSecretStore(opts: BuildSecretStoreOptions = {}): Promise<SecretStore> {
  if (opts.keyVaultUrl && opts.credential) {
    try {
      const { SecretClient } = await import('@azure/keyvault-secrets');
      const client = new SecretClient(opts.keyVaultUrl, opts.credential);
      return new SecretStore({ vault: azureKeyVaultAdapter(client) });
    } catch (err) {
      log.warn(
        { err: (err as Error).message, keyVaultUrl: opts.keyVaultUrl },
        'failed to build Key Vault adapter; falling back to local-only SecretStore',
      );
    }
  }
  return new SecretStore();
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

/** @internal — exported only for tests to reset module-level caches. */
export function __resetSecretStoreCachesForTests(): void {
  _keyring = undefined;
  memory.clear();
}

export { buildPasteBundle, type PasteItem, type PasteBundleOptions, type CostSuggestion } from './paste.js';
export {
  finalizeRun,
  type FinalizeRunArgs,
  type FinalizeRunResult,
  type RunAccumulator,
} from './finalize-run.js';
