import { describe, expect, it } from 'vitest';
import { buildCustomConnectorPayload, downgradeV3ToV2 } from '../src/openapi.js';
import { AppFactoryError } from '@app-factory/shared';

const v3Spec = {
  openapi: '3.0.1',
  info: { title: 'Demo', version: '1.0' },
  servers: [{ url: 'https://api.example.com/v1' }],
  paths: {
    '/widgets/{id}': {
      get: {
        operationId: 'getWidget',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'ok',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Widget' },
              },
            },
          },
        },
      },
      post: {
        operationId: 'createWidget',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/Widget' } },
          },
        },
        responses: {
          '201': {
            description: 'created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Widget' } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Widget: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          parent: { $ref: '#/components/schemas/Widget' },
        },
      },
    },
  },
};

describe('downgradeV3ToV2', () => {
  it('downgrades servers + components + paths into a swagger 2.0 doc', () => {
    const v2 = downgradeV3ToV2(v3Spec) as Record<string, unknown>;
    expect(v2['swagger']).toBe('2.0');
    expect(v2['host']).toBe('api.example.com');
    expect(v2['basePath']).toBe('/v1');
    expect(v2['schemes']).toEqual(['https']);
    const defs = v2['definitions'] as Record<string, unknown>;
    expect(defs['Widget']).toBeDefined();
    const paths = v2['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const get = paths['/widgets/{id}']!['get']!;
    const getParams = get['parameters'] as { name: string; in: string; type?: string }[];
    expect(getParams[0]).toMatchObject({ name: 'id', in: 'path', type: 'string' });
    const getOk = (get['responses'] as Record<string, { schema?: { $ref: string } }>)['200']!;
    expect(getOk.schema?.$ref).toBe('#/definitions/Widget');
    const post = paths['/widgets/{id}']!['post']!;
    const bodyParam = (post['parameters'] as { in: string; schema?: { $ref: string } }[]).find(
      (p) => p.in === 'body',
    );
    expect(bodyParam).toBeDefined();
    expect(bodyParam?.schema?.$ref).toBe('#/definitions/Widget');
  });

  it('rejects unsupported oneOf in v3 specs', () => {
    const bad = {
      openapi: '3.0.0',
      info: { title: 'bad', version: '1' },
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                description: '',
                content: {
                  'application/json': {
                    schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
                  },
                },
              },
            },
          },
        },
      },
    };
    let caught: AppFactoryError | undefined;
    try {
      downgradeV3ToV2(bad);
    } catch (err) {
      caught = err as AppFactoryError;
    }
    expect(caught).toBeInstanceOf(AppFactoryError);
    expect(caught?.code).toBe('OPENAPI_DOWNGRADE_UNSUPPORTED');
    expect(caught?.details?.['feature']).toBe('oneOf');
  });
});

describe('buildCustomConnectorPayload', () => {
  it('emits swagger + apiProperties shaped for pac connector create', () => {
    const v2 = downgradeV3ToV2(v3Spec);
    const payload = buildCustomConnectorPayload(v2);
    expect(payload.swagger['swagger']).toBe('2.0');
    const props = (payload.apiProperties as { properties: { displayName: string } }).properties;
    expect(props.displayName).toBe('Demo');
  });
});
