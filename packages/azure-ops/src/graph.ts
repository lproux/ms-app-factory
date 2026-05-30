import type { TokenCredential } from '@azure/identity';
import { AppFactoryError, createLogger } from '@app-factory/shared';

const log = createLogger('azure-ops:graph');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

export interface GraphClient {
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T>;
}

export function createGraphClient(cred: TokenCredential): GraphClient {
  return {
    async request<T = unknown>(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
      path: string,
      body?: unknown,
    ): Promise<T> {
      const token = await cred.getToken(GRAPH_SCOPE);
      if (!token?.token) {
        throw new AppFactoryError('GRAPH_AUTH', 'failed to acquire Microsoft Graph token');
      }
      const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      const text = await res.text();
      if (!res.ok) {
        log.error({ status: res.status, url, body: text }, 'graph request failed');
        throw new AppFactoryError(
          'GRAPH',
          `graph ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
          { details: { status: res.status, body: text } },
        );
      }
      if (!text) return undefined as unknown as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        return text as unknown as T;
      }
    },
  };
}
