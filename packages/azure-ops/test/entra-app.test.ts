import { describe, it, expect, vi } from 'vitest';
import type { TokenCredential } from '@azure/identity';
import { createEntraApp } from '../src/entra-app.js';
import type { GraphClient } from '../src/graph.js';

const dummyCred: TokenCredential = { getToken: async () => ({ token: 't', expiresOnTimestamp: 0 }) };

describe('createEntraApp', () => {
  it('POSTs /applications with displayName + web.redirectUris + signInAudience and then adds a password', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const graph: GraphClient = {
      request: vi.fn(async (method, path, body) => {
        calls.push({ method, path, body });
        if (path === '/applications') {
          return { id: 'obj-1', appId: 'app-guid-1', displayName: 'my-bot' } as never;
        }
        if (path === '/applications/obj-1/addPassword') {
          return { secretText: 'super-secret', endDateTime: '2099-01-01T00:00:00Z' } as never;
        }
        throw new Error(`unexpected path: ${path}`);
      }),
    };

    const out = await createEntraApp(dummyCred, {
      displayName: 'my-bot',
      redirectUris: ['https://token.botframework.com/.auth/web/redirect'],
      graph,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/applications',
      body: {
        displayName: 'my-bot',
        signInAudience: 'AzureADMyOrg',
        web: { redirectUris: ['https://token.botframework.com/.auth/web/redirect'] },
      },
    });
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.path).toBe('/applications/obj-1/addPassword');
    expect((calls[1]?.body as { passwordCredential: { displayName: string } }).passwordCredential.displayName).toMatch(
      /^app-factory-\d{4}-\d{2}-\d{2}$/,
    );

    expect(out.appId).toBe('app-guid-1');
    expect(out.objectId).toBe('obj-1');
    expect(out.secret).toBe('super-secret');
    expect(out.secretExpiry).toBe('2099-01-01T00:00:00Z');
  });

  it('includes requiredResourceAccess when provided', async () => {
    let lastBody: unknown;
    const graph: GraphClient = {
      request: vi.fn(async (_method, path, body) => {
        if (path === '/applications') {
          lastBody = body;
          return { id: 'obj-2', appId: 'app-guid-2', displayName: 'x' } as never;
        }
        return { secretText: 's', endDateTime: 'z' } as never;
      }),
    };
    await createEntraApp(dummyCred, {
      displayName: 'x',
      requiredResourceAccess: [
        {
          resourceAppId: '00000003-0000-0000-c000-000000000000',
          resourceAccess: [{ id: 'e1fe6dd8-ba31-4d61-89e7-88639da4683d', type: 'Scope' }],
        },
      ],
      graph,
    });
    expect((lastBody as { requiredResourceAccess: unknown[] }).requiredResourceAccess).toHaveLength(1);
  });

  it('omits web when redirectUris is empty', async () => {
    let lastBody: Record<string, unknown> | undefined;
    const graph: GraphClient = {
      request: vi.fn(async (_method, path, body) => {
        if (path === '/applications') {
          lastBody = body as Record<string, unknown>;
          return { id: 'o', appId: 'a', displayName: 'd' } as never;
        }
        return { secretText: 's', endDateTime: 'z' } as never;
      }),
    };
    await createEntraApp(dummyCred, { displayName: 'd', graph });
    expect(lastBody && 'web' in lastBody).toBe(false);
  });
});
