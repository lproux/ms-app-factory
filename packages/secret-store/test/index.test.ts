/**
 * packages/secret-store/test/index.test.ts
 *
 * Covers the SecretStore class after the keytar → @napi-rs/keyring
 * migration. Three behaviours:
 *
 *   1. Happy path: set/get round-trips through a mocked `Entry`.
 *   2. Fallback: when Entry throws AND `APP_FACTORY_ALLOW_MEMORY_SECRETS=1`,
 *      values round-trip through the in-memory map.
 *   3. Hard fail: when Entry throws AND the env is unset, `set` throws
 *      AppFactoryError('SECRET_STORE_UNAVAILABLE').
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Mock @napi-rs/keyring ---------------------------------------------------
// We use a module-level `behavior` object so individual tests can flip the
// Entry to either store values in a fake backing map (happy path) or throw
// (failure paths).
type Behavior = {
  mode: 'ok' | 'throw';
  store: Map<string, string>;
};

const behavior: Behavior = { mode: 'ok', store: new Map() };

vi.mock('@napi-rs/keyring', () => ({
  Entry: class FakeEntry {
    private readonly key: string;
    constructor(public service: string, public account: string) {
      this.key = `${service}::${account}`;
    }
    setPassword(value: string) {
      if (behavior.mode === 'throw') {
        throw new Error('libsecret missing (mock)');
      }
      behavior.store.set(this.key, value);
    }
    getPassword(): string | null {
      if (behavior.mode === 'throw') {
        throw new Error('libsecret missing (mock)');
      }
      return behavior.store.get(this.key) ?? null;
    }
  },
}));

// Imports of the SUT happen AFTER mocks are declared.
import { SecretStore, __resetSecretStoreCachesForTests } from '../src/index.js';
import { AppFactoryError } from '@app-factory/shared';

beforeEach(() => {
  behavior.mode = 'ok';
  behavior.store.clear();
  delete process.env['APP_FACTORY_ALLOW_MEMORY_SECRETS'];
  __resetSecretStoreCachesForTests();
});

afterEach(() => {
  delete process.env['APP_FACTORY_ALLOW_MEMORY_SECRETS'];
});

describe('SecretStore (with @napi-rs/keyring)', () => {
  it('happy path: set then get round-trips a value through the mocked Entry', async () => {
    const store = new SecretStore();
    const ref = await store.set('teams', 'entra-secret', 'super-secret-value');
    expect(ref).toEqual({ scope: 'teams', name: 'entra-secret' });

    // The fake backing map should now contain the entry under the
    // service-prefix scheme that callers rely on.
    expect(behavior.store.get('app-factory:teams::entra-secret')).toBe('super-secret-value');

    const round = await store.get('teams', 'entra-secret');
    expect(round).toBe('super-secret-value');
  });

  it('happy path: get returns null when nothing was previously stored', async () => {
    const store = new SecretStore();
    const v = await store.get('teams', 'missing');
    expect(v).toBeNull();
  });

  it('fallback: when Entry throws AND APP_FACTORY_ALLOW_MEMORY_SECRETS=1, set/get round-trips via memory', async () => {
    behavior.mode = 'throw';
    process.env['APP_FACTORY_ALLOW_MEMORY_SECRETS'] = '1';

    const store = new SecretStore();
    const ref = await store.set('cs', 'invokeUrl', 'https://example.invoke');
    expect(ref).toEqual({ scope: 'cs', name: 'invokeUrl' });

    // OS keyring threw, so the value should NOT be in the keyring's
    // backing store — it lives in the in-memory map instead.
    expect(behavior.store.size).toBe(0);

    const round = await store.get('cs', 'invokeUrl');
    expect(round).toBe('https://example.invoke');
  });

  it('hard fail: when Entry throws AND the env is unset, set throws AppFactoryError("SECRET_STORE_UNAVAILABLE")', async () => {
    behavior.mode = 'throw';
    // env intentionally unset

    const store = new SecretStore();
    await expect(store.set('cs', 'agentId', 'agent-xyz')).rejects.toMatchObject({
      code: 'SECRET_STORE_UNAVAILABLE',
      recoverable: true,
    });

    // Sanity: it really is an AppFactoryError instance.
    await expect(store.set('cs', 'agentId', 'agent-xyz')).rejects.toBeInstanceOf(AppFactoryError);
  });

  it('get is lenient: when Entry throws AND env is unset, get returns null (treated as no-entry)', async () => {
    // `set` enforces APP_FACTORY_ALLOW_MEMORY_SECRETS strictly, but `get` is
    // intentionally soft — `@napi-rs/keyring` throws a NoEntry error rather
    // than returning null when the credential doesn't exist, and we want
    // that to look identical to "found nothing" from the caller's POV.
    behavior.mode = 'throw';

    const store = new SecretStore();
    await expect(store.get('cs', 'agentId')).resolves.toBeNull();
  });

  it('vault adapter is still invoked even when local store is memory-fallback', async () => {
    behavior.mode = 'throw';
    process.env['APP_FACTORY_ALLOW_MEMORY_SECRETS'] = '1';

    const vaultCalls: Array<{ name: string; value: string }> = [];
    const store = new SecretStore({
      vault: {
        async setSecret(name, value) {
          vaultCalls.push({ name, value });
        },
        async getSecret() {
          return null;
        },
      },
    });
    await store.set('cs', 'invokeUrl', 'https://example.invoke');
    expect(vaultCalls).toEqual([{ name: 'cs-invokeUrl', value: 'https://example.invoke' }]);
  });
});
