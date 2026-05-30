import { AppFactoryError, createLogger, span } from '@app-factory/shared';
import type { TokenCredential } from '@azure/identity';

const log = createLogger('azure-ops:cost');

export interface CostSuggestion {
  resource: string;
  recommendation: string;
  estimatedMonthlySavingsUsd?: number;
  source?: string;
}

export interface AdvisorRecommendation {
  id: string;
  name?: string;
  properties?: {
    impactedField?: string;
    impactedValue?: string;
    shortDescription?: { problem?: string; solution?: string };
    extendedProperties?: Record<string, string>;
    category?: string;
    impact?: 'High' | 'Medium' | 'Low';
  };
}

export interface AdvisorRecommendationsResponse {
  value?: AdvisorRecommendation[];
  nextLink?: string;
}

const MANAGEMENT_SCOPE = 'https://management.azure.com/.default';
const ADVISOR_API_VERSION = '2023-01-01';

export interface GetAdvisorCostSuggestionsOptions {
  subscriptionId: string;
  credential: TokenCredential;
  fetchImpl?: typeof fetch;
}

export async function getAdvisorCostSuggestions(
  opts: GetAdvisorCostSuggestionsOptions,
): Promise<CostSuggestion[]> {
  return span('cost:advisor', async () => {
    const fetchFn = opts.fetchImpl ?? fetch;
    const token = await opts.credential.getToken(MANAGEMENT_SCOPE);
    if (!token?.token) {
      throw new AppFactoryError('COST_AUTH', 'Azure management token unavailable for Advisor query', {
        recoverable: true,
      });
    }

    const url = `https://management.azure.com/subscriptions/${encodeURIComponent(
      opts.subscriptionId,
    )}/providers/Microsoft.Advisor/recommendations?api-version=${ADVISOR_API_VERSION}&$filter=${encodeURIComponent(
      "Category eq 'Cost'",
    )}`;

    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new AppFactoryError('COST_ADVISOR_HTTP', `Advisor query failed (${res.status}): ${body}`, {
        recoverable: true,
        details: { status: res.status },
      });
    }
    const data = (await res.json()) as AdvisorRecommendationsResponse;
    const recs = data.value ?? [];
    return recs.map(mapRecommendation);
  });
}

function mapRecommendation(r: AdvisorRecommendation): CostSuggestion {
  const resource = r.properties?.impactedValue ?? r.properties?.impactedField ?? r.name ?? r.id;
  const recommendation =
    r.properties?.shortDescription?.solution ?? r.properties?.shortDescription?.problem ?? 'See Azure Advisor';
  const savingsRaw = r.properties?.extendedProperties?.['savingsAmount'];
  const estimatedMonthlySavingsUsd = savingsRaw ? safeParseFloat(savingsRaw) : undefined;
  return {
    resource,
    recommendation,
    estimatedMonthlySavingsUsd,
    source: 'Azure Advisor',
  };
}

export interface SkuRegionHeuristic {
  match: RegExp;
  replacement: string;
  rationale: string;
  estimatedMonthlySavingsUsd?: number;
}

export const DEFAULT_SKU_HEURISTICS: SkuRegionHeuristic[] = [
  {
    match: /Standard_DS?2_v2/i,
    replacement: 'Standard_B2s',
    rationale: 'Burstable B-series replaces fixed v2 for low-utilization workloads.',
    estimatedMonthlySavingsUsd: 35,
  },
  {
    match: /Standard_D4s?_v3/i,
    replacement: 'Standard_D4as_v5',
    rationale: 'AMD v5 SKU costs ~15% less for equivalent CPU class.',
    estimatedMonthlySavingsUsd: 50,
  },
  {
    match: /Premium_LRS/i,
    replacement: 'StandardSSD_LRS',
    rationale: 'StandardSSD covers most non-IO-bound workloads at ~40% lower cost.',
    estimatedMonthlySavingsUsd: 18,
  },
];

export interface SkuRegionInput {
  resource: string;
  sku?: string;
  region?: string;
}

export function applySkuRegionHeuristics(
  inputs: SkuRegionInput[],
  heuristics: SkuRegionHeuristic[] = DEFAULT_SKU_HEURISTICS,
): CostSuggestion[] {
  const out: CostSuggestion[] = [];
  for (const inp of inputs) {
    if (!inp.sku) continue;
    for (const h of heuristics) {
      if (h.match.test(inp.sku)) {
        out.push({
          resource: inp.resource,
          recommendation: `Swap SKU ${inp.sku} → ${h.replacement}: ${h.rationale}`,
          estimatedMonthlySavingsUsd: h.estimatedMonthlySavingsUsd,
          source: 'sku-heuristic',
        });
      }
    }
  }
  return out;
}

export interface OptimizeCostInputs {
  subscriptionId: string;
  credential: TokenCredential;
  resources?: SkuRegionInput[];
  fetchImpl?: typeof fetch;
}

export async function optimizeCost(opts: OptimizeCostInputs): Promise<CostSuggestion[]> {
  const out: CostSuggestion[] = [];
  try {
    const advisor = await getAdvisorCostSuggestions({
      subscriptionId: opts.subscriptionId,
      credential: opts.credential,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    out.push(...advisor);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Advisor query failed; falling back to heuristics only');
  }
  if (opts.resources && opts.resources.length > 0) {
    out.push(...applySkuRegionHeuristics(opts.resources));
  }
  return dedupe(out);
}

function dedupe(items: CostSuggestion[]): CostSuggestion[] {
  const seen = new Set<string>();
  const out: CostSuggestion[] = [];
  for (const it of items) {
    const key = `${it.resource}::${it.recommendation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return `<unreadable body, status ${res.status}>`;
  }
}

function safeParseFloat(v: string): number | undefined {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}
