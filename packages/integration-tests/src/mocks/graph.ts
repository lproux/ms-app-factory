import { callRecorder } from './call-recorder.js';

/**
 * Fake Microsoft Graph client matching the interface in
 * `packages/azure-ops/src/graph.ts`.
 *
 * Responds with canned payloads for the endpoints the WBS hits:
 * - POST /applications → app create
 * - POST /servicePrincipals → SP create
 * - POST /applications/{id}/addPassword → secret mint
 * - GET /directoryRoles?... → existing directory role
 * - POST /directoryRoles → activated directory role
 * - POST /directoryRoles/{id}/members/$ref → role member
 */
export interface GraphFake {
  request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<T>;
}

const APP_OBJ_ID = '00000000-1111-2222-3333-444444444444';
const APP_APP_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SP_OBJ_ID = '11111111-2222-3333-4444-555555555555';
const DIR_ROLE_ID = '22222222-3333-4444-5555-666666666666';

let appCounter = 0;
let spCounter = 0;

export function resetGraphCounters(): void {
  appCounter = 0;
  spCounter = 0;
}

export function makeGraphMock(): GraphFake {
  return {
    async request<T = unknown>(
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
      path: string,
      _body?: unknown,
    ): Promise<T> {
      callRecorder.record({ kind: 'graph', target: path, method });

      if (method === 'POST' && path === '/applications') {
        appCounter += 1;
        return {
          id: `${APP_OBJ_ID}-${appCounter}`,
          appId: `${APP_APP_ID}-${appCounter}`,
          displayName: 'fake-app',
        } as unknown as T;
      }
      if (method === 'POST' && path === '/servicePrincipals') {
        spCounter += 1;
        return {
          id: `${SP_OBJ_ID}-${spCounter}`,
          appId: `${APP_APP_ID}-${spCounter}`,
          displayName: 'fake-sp',
        } as unknown as T;
      }
      if (method === 'POST' && /\/applications\/[^/]+\/addPassword$/.test(path)) {
        return {
          secretText: 'fake-secret-value',
          endDateTime: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
        } as unknown as T;
      }
      if (method === 'GET' && /^\/directoryRoles\?\$filter=/.test(path)) {
        return {
          value: [{ id: DIR_ROLE_ID, roleTemplateId: '158c047a-c907-4556-b7ef-446551a6b5f7' }],
        } as unknown as T;
      }
      if (method === 'POST' && path === '/directoryRoles') {
        return { id: DIR_ROLE_ID } as unknown as T;
      }
      if (method === 'POST' && /\/directoryRoles\/[^/]+\/members\/\$ref$/.test(path)) {
        return {} as unknown as T;
      }
      return {} as unknown as T;
    },
  };
}
