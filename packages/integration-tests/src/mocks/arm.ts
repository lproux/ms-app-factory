import { callRecorder } from './call-recorder.js';

/**
 * Fakes for the @azure/arm-* packages we touch.
 *
 * Each "Client" is a class whose only purpose is to expose the same nested
 * object shape that the real SDK does. The methods record their calls and
 * return canned data.
 */

const FAKE_SUB_ID = '00000000-0000-0000-0000-000000000001';
const FAKE_TENANT_ID = '11111111-1111-1111-1111-111111111111';

export class FakeSubscriptionClient {
  subscriptions = {
    list(): AsyncIterable<{
      subscriptionId: string;
      displayName: string;
      tenantId: string;
      state: string;
    }> {
      callRecorder.record({ kind: 'arm', target: 'SubscriptionClient.subscriptions.list' });
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            subscriptionId: FAKE_SUB_ID,
            displayName: 'Fake Sub 1',
            tenantId: FAKE_TENANT_ID,
            state: 'Enabled',
          };
        },
      };
    },
  };
}

export class FakeResourceManagementClient {
  constructor(_cred: unknown, public subId: string) {}

  resourceGroups = {
    get: async (name: string): Promise<{ id: string; name: string; location: string } | undefined> => {
      callRecorder.record({
        kind: 'arm',
        target: 'ResourceManagementClient.resourceGroups.get',
        argv: [name],
      });
      // Pretend it doesn't exist yet → forces createOrUpdate path.
      const err = new Error('ResourceGroupNotFound') as Error & {
        statusCode?: number;
        code?: string;
      };
      err.statusCode = 404;
      err.code = 'ResourceGroupNotFound';
      throw err;
    },
    createOrUpdate: async (
      name: string,
      params: { location: string },
    ): Promise<{ id: string; name: string; location: string }> => {
      callRecorder.record({
        kind: 'arm',
        target: 'ResourceManagementClient.resourceGroups.createOrUpdate',
        argv: [name, params],
      });
      return {
        id: `/subscriptions/${this.subId}/resourceGroups/${name}`,
        name,
        location: params.location,
      };
    },
  };

  resources = {
    beginCreateOrUpdateAndWait: async (
      rg: string,
      provider: string,
      _parent: string,
      type: string,
      resourceName: string,
      _api: string,
      params: Record<string, unknown>,
    ): Promise<{ id: string }> => {
      callRecorder.record({
        kind: 'arm',
        target: 'ResourceManagementClient.resources.beginCreateOrUpdateAndWait',
        argv: [rg, provider, type, resourceName, params],
      });
      return {
        id: `/subscriptions/${this.subId}/resourceGroups/${rg}/providers/${provider}/${type}/${resourceName}`,
      };
    },
  };
}

export class FakeAuthorizationManagementClient {
  constructor(_cred: unknown, public subId: string) {}

  roleAssignments = {
    create: async (
      scope: string,
      assignmentName: string,
      params: Record<string, unknown>,
    ): Promise<{ id: string }> => {
      callRecorder.record({
        kind: 'arm',
        target: 'AuthorizationManagementClient.roleAssignments.create',
        argv: [scope, assignmentName, params],
      });
      return { id: `${scope}/providers/Microsoft.Authorization/roleAssignments/${assignmentName}` };
    },
  };
}

export const ARM_FAKES = {
  FakeSubscriptionClient,
  FakeResourceManagementClient,
  FakeAuthorizationManagementClient,
  FAKE_SUB_ID,
  FAKE_TENANT_ID,
};
