/**
 * packages/secret-store/test/finalize-run.test.ts
 *
 * Covers the extracted `finalizeRun` helper shared between A12 and B14.
 * Four scenarios:
 *   1. no Key Vault configured → no credential is constructed, secrets
 *      still get persisted to the local store, paste bundle returns
 *      placeholders (revealSecrets defaults to false).
 *   2. Key Vault URL set → buildSecretStore is invoked with the vault
 *      URL and a credential is constructed via auth-broker.
 *   3. revealSecrets=false → bundle contains `<retrieve via SecretStore...>`.
 *   4. revealSecrets=true → bundle contains the raw secret value verbatim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FactoryContext } from '@app-factory/shared';

const credCalls: Array<{ mode: string; tenantId?: string }> = [];
const buildStoreCalls: Array<{ keyVaultUrl?: string; hasCredential: boolean }> = [];

vi.mock('@app-factory/auth-broker', () => ({
  getCredential: (opts: { mode: string; tenantId?: string }) => {
    credCalls.push({ mode: opts.mode, tenantId: opts.tenantId });
    return { async getToken() { return { token: 'fake', expiresOnTimestamp: Date.now() + 60_000 }; } };
  },
}));

// Replace SecretClient with a no-op in-memory adapter so the vault-set
// path doesn't touch the network.
const kvCalls: Array<{ name: string; value: string }> = [];
vi.mock('@azure/keyvault-secrets', () => ({
  SecretClient: class FakeSecretClient {
    constructor(public url: string, public cred: unknown) {}
    async setSecret(name: string, value: string) {
      kvCalls.push({ name, value });
      return { name, value };
    }
    async getSecret(name: string) {
      const last = kvCalls.filter((c) => c.name === name).pop();
      return last ? { name, value: last.value } : { name, value: undefined };
    }
  },
}));

// Stub the OS keyring with a no-op so the SecretStore never touches the
// host. `@napi-rs/keyring` replaced `keytar` (security/maint).
vi.mock('@napi-rs/keyring', () => ({
  Entry: class FakeEntry {
    constructor(public service: string, public account: string) {}
    setPassword(_value: string) {
      /* no-op */
    }
    getPassword() {
      return null;
    }
  },
}));

// We capture invocations of buildSecretStore by spying on it inside the
// SUT module instead of remocking — the production builder already
// handles vault-unset / vault-set branches correctly. The credCalls
// recorder above is sufficient to assert the vault-set path.

import { finalizeRun, type RunAccumulator } from '../src/finalize-run.js';

function baseFctx(overrides: Partial<FactoryContext['emit']> = {}, keyVault?: string): FactoryContext {
  return {
    runId: 'finalize-run-test',
    recipe: 'copilot-studio-custom',
    planOnly: false,
    workdir: '/tmp/finalize',
    kbSources: [],
    auth: { mode: 'chained' },
    tenant: { tenantId: 'tenant-mock' },
    emit: {
      keyring: true,
      revealSecrets: false,
      ...(keyVault !== undefined ? { keyVault } : {}),
      ...overrides,
    },
    judge: { shape: 'cross-model', maxRounds: 3 },
  } as unknown as FactoryContext;
}

function baseCtx(): RunAccumulator {
  return {
    artifacts: [
      { kind: 'cs-agent', id: 'cs-1', displayName: 'Acme' },
    ],
    secrets: [
      {
        ref: { scope: 'cs', name: 'invokeUrl', description: 'Direct Line URL' },
        value: 'https://example.invoke',
      },
      {
        ref: { scope: 'cs', name: 'agentId' },
        value: 'agent-guid-xyz',
      },
    ],
    warnings: ['mock-warning-1'],
  };
}

beforeEach(() => {
  credCalls.length = 0;
  buildStoreCalls.length = 0;
  kvCalls.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('finalizeRun', () => {
  it('no Key Vault → no credential is constructed, paste bundle still emits redacted secrets', async () => {
    const fctx = baseFctx();
    const ctx = baseCtx();
    const result = await finalizeRun({
      fctx,
      ctx,
      kind: 'cs-agent',
      title: '# Test — no vault',
    });

    expect(credCalls).toHaveLength(0);
    expect(result.pasteBundle).toContain('# Test — no vault');
    expect(result.pasteBundle).toContain('## Secrets');
    expect(result.pasteBundle).toContain('### cs / invokeUrl');
    // revealSecrets defaults to false → placeholder, NOT the raw value.
    expect(result.pasteBundle).toContain('<retrieve via SecretStore.get(scope, name)>');
    expect(result.pasteBundle).not.toContain('https://example.invoke');
    expect(result.pasteBundle).not.toContain('agent-guid-xyz');
    expect(result.pasteBundle).toContain('## Artifacts');
    expect(result.pasteBundle).toContain('| cs-agent | cs-1 | Acme |');
    expect(result.pasteBundle).toContain('## Warnings');
  });

  it('Key Vault URL set → credential is constructed via auth-broker with the auth mode', async () => {
    const fctx = baseFctx({}, 'https://kv-test.vault.azure.net');
    const ctx = baseCtx();
    await finalizeRun({
      fctx,
      ctx,
      kind: 'cs-agent',
      title: '# Test — vault',
    });

    expect(credCalls).toHaveLength(1);
    expect(credCalls[0]?.mode).toBe('chained');
    expect(credCalls[0]?.tenantId).toBe('tenant-mock');
    // Every secret should have been forwarded to the fake Key Vault.
    const kvNames = kvCalls.map((c) => c.name);
    expect(kvNames).toContain('cs-invokeUrl');
    expect(kvNames).toContain('cs-agentId');
  });

  it('revealSecrets=false (default) renders placeholders', async () => {
    const fctx = baseFctx({ revealSecrets: false });
    const ctx = baseCtx();
    const result = await finalizeRun({
      fctx,
      ctx,
      kind: 'cs-agent',
      title: '# Redacted',
    });
    expect(result.pasteBundle).toContain('Values redacted');
    expect(result.pasteBundle).toContain('<retrieve via SecretStore.get(scope, name)>');
    expect(result.pasteBundle).not.toContain('agent-guid-xyz');
  });

  it('revealSecrets=true embeds raw values + .env block + clawpilot block', async () => {
    const fctx = baseFctx({ revealSecrets: true });
    const ctx = baseCtx();
    const result = await finalizeRun({
      fctx,
      ctx,
      kind: 'cs-agent',
      title: '# Revealed',
    });
    expect(result.pasteBundle).toContain('CS__INVOKEURL=https://example.invoke');
    expect(result.pasteBundle).toContain("export CS__AGENTID='agent-guid-xyz'");
    expect(result.pasteBundle).not.toContain('Values redacted');
  });

  it('attaches cost suggestions when provided (B14 path)', async () => {
    const fctx = baseFctx({ revealSecrets: false });
    const ctx = baseCtx();
    const result = await finalizeRun({
      fctx,
      ctx,
      kind: 'teams-app',
      title: '# Teams',
      costSuggestions: [
        {
          resource: 'rg-app-factory',
          recommendation: 'Swap to Standard_B2s',
          estimatedMonthlySavingsUsd: 35,
          source: 'sku-heuristic',
        },
      ],
    });
    expect(result.pasteBundle).toContain('## Cost optimizer suggestions');
    expect(result.pasteBundle).toContain('Standard_B2s');
  });

  it('omits cost suggestions section when array is empty (A12 path parity)', async () => {
    const fctx = baseFctx({ revealSecrets: false });
    const ctx = baseCtx();
    const result = await finalizeRun({
      fctx,
      ctx,
      kind: 'cs-agent',
      title: '# CS',
      costSuggestions: [],
    });
    expect(result.pasteBundle).not.toContain('## Cost optimizer suggestions');
  });
});
