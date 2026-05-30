import type { TokenCredential } from '@azure/identity';
import { AppFactoryError, createLogger, ProvisioningError } from '@app-factory/shared';

const log = createLogger('copilot-studio:dataverse');

export interface DataverseClientOptions {
  /** Environment URL, e.g. https://orgxxx.crm.dynamics.com */
  envUrl: string;
  credential: TokenCredential;
  /** Override the OData base path. Defaults to /api/data/v9.2 */
  apiPath?: string;
  fetchImpl?: typeof fetch;
}

export interface DataverseQueryOptions {
  $select?: string;
  $expand?: string;
  $filter?: string;
  $top?: number;
  $orderby?: string;
}

export class DataverseClient {
  readonly envUrl: string;
  readonly apiPath: string;
  private readonly credential: TokenCredential;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DataverseClientOptions) {
    this.envUrl = opts.envUrl.replace(/\/$/, '');
    this.apiPath = opts.apiPath ?? '/api/data/v9.2';
    this.credential = opts.credential;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new AppFactoryError(
        'DATAVERSE_NO_FETCH',
        'No fetch implementation available; pass fetchImpl explicitly.',
      );
    }
  }

  private async authHeader(): Promise<string> {
    const scope = `${this.envUrl}/.default`;
    const token = await this.credential.getToken(scope);
    if (!token) throw new AppFactoryError('DATAVERSE_NO_TOKEN', `failed to acquire token for ${scope}`);
    return `Bearer ${token.token}`;
  }

  private buildUrl(path: string, query?: DataverseQueryOptions | string): string {
    const base = `${this.envUrl}${this.apiPath}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return base;
    if (typeof query === 'string') {
      return query.length ? `${base}${query.startsWith('?') ? '' : '?'}${query}` : base;
    }
    const params = new URLSearchParams();
    if (query.$select) params.set('$select', query.$select);
    if (query.$expand) params.set('$expand', query.$expand);
    if (query.$filter) params.set('$filter', query.$filter);
    if (query.$top !== undefined) params.set('$top', String(query.$top));
    if (query.$orderby) params.set('$orderby', query.$orderby);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  }

  private async request<T>(
    method: string,
    url: string,
    init: {
      body?: string | Buffer | Uint8Array;
      headers?: Record<string, string>;
      expectJson?: boolean;
    } = {},
  ): Promise<{ status: number; headers: Headers; body: T | undefined; raw: string }> {
    const auth = await this.authHeader();
    const headers: Record<string, string> = {
      Authorization: auth,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      ...init.headers,
    };
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: init.body as BodyInit | undefined,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new ProvisioningError(`dataverse ${method} ${url} failed: ${res.status}`, {
        details: { status: res.status, body: raw.slice(0, 4000) },
      });
    }
    let body: T | undefined;
    if (init.expectJson !== false && raw.length > 0) {
      try {
        body = JSON.parse(raw) as T;
      } catch {
        body = undefined;
      }
    }
    return { status: res.status, headers: res.headers, body, raw };
  }

  /** Create a record; returns the new record id (extracted from OData-EntityId header). */
  async createRecord<T extends Record<string, unknown> = Record<string, unknown>>(
    entitySet: string,
    payload: Record<string, unknown>,
  ): Promise<{ id: string; record?: T }> {
    const url = this.buildUrl(entitySet);
    const res = await this.request<T>('POST', url, {
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'If-None-Match': 'null',
      },
    });
    const id = extractEntityId(res.headers.get('OData-EntityId') ?? '') ?? (res.body as { [k: string]: unknown })?.[`${trimEntityName(entitySet)}id`]?.toString() ?? '';
    if (!id) {
      log.warn({ entitySet }, 'createRecord could not extract id; header missing');
    }
    return { id, record: res.body };
  }

  async getRecord<T = unknown>(
    entitySet: string,
    id: string,
    select?: string,
    expand?: string,
  ): Promise<T> {
    const url = this.buildUrl(`${entitySet}(${id})`, { $select: select, $expand: expand });
    const res = await this.request<T>('GET', url);
    if (res.body === undefined) {
      throw new ProvisioningError(`dataverse GET ${url} returned no body`);
    }
    return res.body;
  }

  async patchRecord<T = unknown>(
    entitySet: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<T | undefined> {
    const url = this.buildUrl(`${entitySet}(${id})`);
    const res = await this.request<T>('PATCH', url, {
      body: JSON.stringify(payload),
      headers: {
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        'If-Match': '*',
      },
    });
    return res.body;
  }

  /** Upload bytes into a Dataverse binary column (Image / File). */
  async uploadBinaryColumn(
    entitySet: string,
    id: string,
    column: string,
    bytes: Buffer | Uint8Array,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    const url = this.buildUrl(`${entitySet}(${id})/${column}`);
    await this.request('PATCH', url, {
      body: bytes,
      expectJson: false,
      headers: {
        'Content-Type': contentType,
      },
    });
  }

  async query<T = Record<string, unknown>>(
    entitySet: string,
    query: DataverseQueryOptions | string = {},
  ): Promise<T[]> {
    const url = this.buildUrl(entitySet, query);
    const res = await this.request<{ value?: T[] }>('GET', url);
    return res.body?.value ?? [];
  }
}

function extractEntityId(headerValue: string): string | undefined {
  if (!headerValue) return undefined;
  const m = /\(([0-9a-fA-F-]{36})\)\s*$/.exec(headerValue);
  return m?.[1];
}

function trimEntityName(entitySet: string): string {
  // crude singularization: "accounts" → "account", "cat_filesynchronizations" → "cat_filesynchronization"
  return entitySet.endsWith('s') ? entitySet.slice(0, -1) : entitySet;
}
