import { describe, expect, it, vi } from 'vitest';
import { applySkuRegionHeuristics, getAdvisorCostSuggestions, optimizeCost } from '../src/cost.js';
import type { TokenCredential } from '@azure/identity';

function fakeCredential(token = 'tok'): TokenCredential {
  return {
    async getToken() {
      return { token, expiresOnTimestamp: Date.now() + 60_000 };
    },
  };
}

describe('applySkuRegionHeuristics', () => {
  it('emits a suggestion when SKU matches', () => {
    const out = applySkuRegionHeuristics([
      { resource: 'vm-1', sku: 'Standard_DS2_v2', region: 'eastus' },
      { resource: 'vm-2', sku: 'Standard_F8s_v2', region: 'eastus' },
      { resource: 'disk-1', sku: 'Premium_LRS', region: 'eastus' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.resource).toBe('vm-1');
    expect(out[0]?.recommendation).toContain('Standard_B2s');
    expect(out[1]?.resource).toBe('disk-1');
    expect(out[1]?.recommendation).toContain('StandardSSD_LRS');
  });

  it('returns empty when nothing matches', () => {
    expect(applySkuRegionHeuristics([{ resource: 'x', sku: 'Standard_NC96ads_A100_v4' }])).toEqual([]);
  });

  it('skips inputs missing SKU', () => {
    expect(applySkuRegionHeuristics([{ resource: 'x' }])).toEqual([]);
  });
});

describe('getAdvisorCostSuggestions', () => {
  it('maps Advisor recommendations to CostSuggestions', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          value: [
            {
              id: '/sub/123/rec/1',
              name: 'rec-1',
              properties: {
                impactedField: 'Microsoft.Compute/virtualMachines',
                impactedValue: 'vm-foo',
                shortDescription: { problem: 'underutilized', solution: 'right-size vm-foo' },
                extendedProperties: { savingsAmount: '42.50' },
                category: 'Cost',
                impact: 'High',
              },
            },
          ],
        };
      },
    })) as unknown as typeof fetch;

    const out = await getAdvisorCostSuggestions({
      subscriptionId: 'sub-1',
      credential: fakeCredential(),
      fetchImpl: fakeFetch,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.resource).toBe('vm-foo');
    expect(out[0]?.recommendation).toBe('right-size vm-foo');
    expect(out[0]?.estimatedMonthlySavingsUsd).toBe(42.5);
    expect(out[0]?.source).toBe('Azure Advisor');

    const call = (fakeFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(call?.[0]).toContain('Microsoft.Advisor/recommendations');
    expect(call?.[0]).toContain('Cost');
  });

  it('throws recoverable error on non-OK response', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      async text() {
        return 'Forbidden';
      },
    })) as unknown as typeof fetch;

    await expect(
      getAdvisorCostSuggestions({
        subscriptionId: 'sub-1',
        credential: fakeCredential(),
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow(/Advisor query failed \(403\)/);
  });
});

describe('optimizeCost', () => {
  it('combines Advisor results with heuristic results', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          value: [
            {
              id: '/sub/1/rec/a',
              properties: {
                impactedValue: 'vm-a',
                shortDescription: { solution: 'shut down vm-a' },
              },
            },
          ],
        };
      },
    })) as unknown as typeof fetch;

    const out = await optimizeCost({
      subscriptionId: 'sub-1',
      credential: fakeCredential(),
      fetchImpl: fakeFetch,
      resources: [{ resource: 'vm-b', sku: 'Standard_DS2_v2', region: 'eastus' }],
    });
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out.find((s) => s.resource === 'vm-a')).toBeDefined();
    expect(out.find((s) => s.resource === 'vm-b')).toBeDefined();
  });

  it('still returns heuristic results if Advisor fails', async () => {
    const fakeFetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      async text() {
        return 'oops';
      },
    })) as unknown as typeof fetch;

    const out = await optimizeCost({
      subscriptionId: 'sub-1',
      credential: fakeCredential(),
      fetchImpl: fakeFetch,
      resources: [{ resource: 'vm-x', sku: 'Standard_DS2_v2' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('sku-heuristic');
  });
});
