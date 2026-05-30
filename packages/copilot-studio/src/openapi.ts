import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AppFactoryError, createLogger } from '@app-factory/shared';
import { connectorCreate, type PacWrapper } from './pac.js';

const log = createLogger('copilot-studio:openapi');

export type SwaggerVersion = 'v2' | 'v3';

export interface LoadedSpec {
  spec: Record<string, unknown>;
  version: SwaggerVersion;
}

export async function loadOpenApi(source: string): Promise<LoadedSpec> {
  let raw: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new AppFactoryError('OPENAPI_FETCH_FAILED', `${source} → ${res.status}`);
    raw = await res.text();
  } else {
    raw = await fs.readFile(source, 'utf8');
  }
  const spec = await parseSpec(raw, source);
  const version = detectVersion(spec);
  return { spec, version };
}

async function parseSpec(raw: string, source: string): Promise<Record<string, unknown>> {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  const yamlMod = (await import('yaml')) as { parse: (s: string) => unknown };
  const parsed = yamlMod.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new AppFactoryError('OPENAPI_PARSE_FAILED', `could not parse ${source} as JSON or YAML`);
  }
  return parsed as Record<string, unknown>;
}

function detectVersion(spec: Record<string, unknown>): SwaggerVersion {
  if (typeof spec['openapi'] === 'string' && (spec['openapi'] as string).startsWith('3.')) return 'v3';
  if (spec['swagger'] === '2.0') return 'v2';
  if (spec['openapi']) return 'v3';
  return 'v2';
}

// ---------------------------------------------------------------------------
// v3 → v2 downgrade
// ---------------------------------------------------------------------------

export function downgradeV3ToV2(spec: Record<string, unknown>): Record<string, unknown> {
  if (detectVersion(spec) === 'v2') return spec;
  const v2: Record<string, unknown> = {
    swagger: '2.0',
    info: spec['info'] ?? { title: 'untitled', version: '1.0.0' },
  };

  // servers → host + basePath + schemes
  const servers = spec['servers'];
  if (Array.isArray(servers) && servers.length > 0) {
    const first = servers[0] as { url?: string } | undefined;
    if (first?.url) {
      try {
        const u = new URL(first.url);
        v2['host'] = u.host;
        v2['basePath'] = u.pathname.replace(/\/+$/, '') || '/';
        v2['schemes'] = [u.protocol.replace(':', '')];
      } catch {
        v2['basePath'] = first.url;
      }
    }
  }

  const components = (spec['components'] as Record<string, unknown> | undefined) ?? {};

  // components.schemas → definitions
  if (components['schemas']) {
    v2['definitions'] = rewriteRefs(components['schemas'] as Record<string, unknown>);
  }

  // components.securitySchemes → securityDefinitions
  if (components['securitySchemes']) {
    v2['securityDefinitions'] = rewriteRefs(components['securitySchemes'] as Record<string, unknown>);
  }

  // paths conversion (operations / parameters / requestBody / responses)
  const paths = spec['paths'] as Record<string, unknown> | undefined;
  if (paths) {
    v2['paths'] = convertPaths(paths);
  }

  if (spec['tags']) v2['tags'] = spec['tags'];
  if (spec['security']) v2['security'] = spec['security'];

  return v2;
}

function convertPaths(paths: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') {
      out[pathKey] = pathItem;
      continue;
    }
    const item = pathItem as Record<string, unknown>;
    const newItem: Record<string, unknown> = {};
    for (const [opKey, opVal] of Object.entries(item)) {
      if (!isHttpVerb(opKey)) {
        newItem[opKey] = opVal;
        continue;
      }
      newItem[opKey] = convertOperation(opVal as Record<string, unknown>, `${pathKey}.${opKey}`);
    }
    out[pathKey] = newItem;
  }
  return out;
}

function isHttpVerb(s: string): boolean {
  return ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'].includes(s.toLowerCase());
}

function convertOperation(op: Record<string, unknown>, debugPath: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...op };
  const params: Record<string, unknown>[] = Array.isArray(out['parameters'])
    ? (out['parameters'] as Record<string, unknown>[]).map((p) => convertParam(p))
    : [];

  // requestBody → in:body parameter
  const rb = out['requestBody'] as Record<string, unknown> | undefined;
  if (rb) {
    const content = rb['content'] as Record<string, { schema?: unknown }> | undefined;
    const mt = content ? Object.keys(content)[0] : undefined;
    const schema = mt && content?.[mt]?.schema;
    params.push({
      name: 'body',
      in: 'body',
      required: rb['required'] ?? false,
      schema: schema ? rewriteRefs(schema as Record<string, unknown>) : { type: 'object' },
    });
    delete out['requestBody'];
    if (mt) {
      const consumes = (out['consumes'] as string[] | undefined) ?? [];
      if (!consumes.includes(mt)) consumes.push(mt);
      out['consumes'] = consumes;
    }
  }
  if (params.length) out['parameters'] = params;

  // responses[code].content[mt].schema → response.schema
  const responses = out['responses'] as Record<string, unknown> | undefined;
  if (responses) {
    const newResponses: Record<string, unknown> = {};
    for (const [code, val] of Object.entries(responses)) {
      const r = val as Record<string, unknown>;
      const content = r['content'] as Record<string, { schema?: unknown }> | undefined;
      const mt = content ? Object.keys(content)[0] : undefined;
      const schema = mt && content?.[mt]?.schema;
      newResponses[code] = {
        description: r['description'] ?? '',
        ...(schema ? { schema: rewriteRefs(schema as Record<string, unknown>) } : {}),
      };
    }
    out['responses'] = newResponses;
  }

  assertNoUnsupportedFeatures(out, debugPath);
  return out;
}

function convertParam(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p };
  const schema = out['schema'] as Record<string, unknown> | undefined;
  if (schema && out['in'] !== 'body') {
    // v2 query/path/header params inline schema fields, not a sub-object.
    if ('type' in schema) out['type'] = schema['type'];
    if ('format' in schema) out['format'] = schema['format'];
    if ('enum' in schema) out['enum'] = schema['enum'];
    delete out['schema'];
  }
  if (schema && out['in'] === 'body') {
    out['schema'] = rewriteRefs(schema);
  }
  return out;
}

function rewriteRefs<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => rewriteRefs(n)) as unknown as T;
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        out[k] = v
          .replace('#/components/schemas/', '#/definitions/')
          .replace('#/components/parameters/', '#/parameters/')
          .replace('#/components/responses/', '#/responses/')
          .replace('#/components/securitySchemes/', '#/securityDefinitions/');
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out as unknown as T;
  }
  return node;
}

function assertNoUnsupportedFeatures(op: Record<string, unknown>, debugPath: string): void {
  scan(op, debugPath, '');
}

function scan(node: unknown, debugPath: string, here: string): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n, i) => scan(n, debugPath, `${here}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'oneOf' || k === 'anyOf' || k === 'patternProperties') {
      // Schemas using oneOf/anyOf with a `discriminator` collapse to a nominal type that
      // Swagger v2 can represent (via x-ms-discriminator-value), but the generic case has
      // no v2 equivalent.
      const sibling = node as Record<string, unknown>;
      if (!sibling['type'] && !sibling['discriminator']) {
        throw new AppFactoryError(
          'OPENAPI_DOWNGRADE_UNSUPPORTED',
          `v3 feature ${k} is not representable in OpenAPI v2 (${debugPath} ${here}/${k})`,
          { details: { feature: k, path: `${debugPath}${here}/${k}` } },
        );
      }
    }
    scan(v, debugPath, `${here}/${k}`);
  }
}

// ---------------------------------------------------------------------------
// Custom-connector payload builder + pac wrapper
// ---------------------------------------------------------------------------

export interface CustomConnectorPayload {
  swagger: Record<string, unknown>;
  apiProperties: Record<string, unknown>;
}

export function buildCustomConnectorPayload(swaggerV2: Record<string, unknown>): CustomConnectorPayload {
  if (swaggerV2['swagger'] !== '2.0') {
    throw new AppFactoryError(
      'OPENAPI_BAD_INPUT',
      'buildCustomConnectorPayload expects an OpenAPI v2 (swagger 2.0) document',
    );
  }
  const title = ((swaggerV2['info'] as { title?: string } | undefined)?.title ?? 'Connector').toString();
  return {
    swagger: swaggerV2,
    apiProperties: {
      properties: {
        connectionParameters: {},
        iconBrandColor: '#007ee5',
        capabilities: [],
        publisher: 'App Factory',
        stackOwner: 'App Factory',
        displayName: title,
      },
    },
  };
}

export interface CreateConnectorOptions {
  pacWrapper: PacWrapper;
  envId?: string;
}

export async function createCustomConnector(
  spec: Record<string, unknown>,
  opts: CreateConnectorOptions,
): Promise<{ apiDefinitionFile: string; apiPropertiesFile: string }> {
  const v2 = downgradeV3ToV2(spec);
  const payload = buildCustomConnectorPayload(v2);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-connector-'));
  const apiDef = path.join(dir, 'apiDefinition.json');
  const apiProps = path.join(dir, 'apiProperties.json');
  await fs.writeFile(apiDef, JSON.stringify(payload.swagger, null, 2), 'utf8');
  await fs.writeFile(apiProps, JSON.stringify(payload.apiProperties, null, 2), 'utf8');
  await opts.pacWrapper.connectorCreate({
    apiDefinitionFile: apiDef,
    apiPropertiesFile: apiProps,
    envId: opts.envId,
  });
  log.info({ apiDef, envId: opts.envId }, 'custom connector created');
  return { apiDefinitionFile: apiDef, apiPropertiesFile: apiProps };
}
