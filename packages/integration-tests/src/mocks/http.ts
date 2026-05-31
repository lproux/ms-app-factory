import { callRecorder } from './call-recorder.js';

/**
 * A tiny global-fetch replacement that records URLs and returns canned
 * responses. We use this in lieu of `nock` for non-Graph HTTP calls
 * (e.g., Direct Line judge endpoints, Azure Advisor cost API).
 *
 * Tests install via `vi.stubGlobal('fetch', makeFetchMock(...))`.
 */
export interface FetchHandler {
  match: (url: string, init?: RequestInit) => boolean;
  respond: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body: string; headers?: Record<string, string> };
}

export function jsonResponse(body: unknown, status = 200): {
  status: number;
  body: string;
  headers: Record<string, string>;
} {
  return {
    status,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

export function makeFetchMock(handlers: FetchHandler[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    callRecorder.record({ kind: 'http', target: 'fetch', url, method });

    for (const h of handlers) {
      if (h.match(url, init)) {
        const out = h.respond(url, init);
        const headers = new Headers(out.headers ?? {});
        return new Response(out.body, { status: out.status, headers });
      }
    }
    // Default to 200 empty JSON to avoid hard-failing tests when a previously
    // unaccounted-for fetch fires; tests can assert on callRecorder.
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/**
 * A fetch mock that *throws* if any URL is hit. Used by plan-mode tests to
 * prove no outbound HTTP happens.
 */
export function makeForbiddenFetchMock(): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? 'GET';
    callRecorder.record({ kind: 'http', target: 'fetch-forbidden', url, method });
    throw new Error(`PLAN_MODE_FETCH_FORBIDDEN: ${method} ${url}`);
  }) as unknown as typeof fetch;
}
