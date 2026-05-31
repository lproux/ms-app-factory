# Logo pipeline

`@app-factory/logo-pipeline` produces the icon variants every recipe needs (a
192×192 colour PNG and a 32×32 outline PNG) from one of three sources, chosen
in strict precedence order.

## Precedence

1. **User-supplied file** — if `FactoryContext.brand.logoPath` is set, the
   file at that path is read and run through the `sharp` resize pipeline.
   No network calls, no provider involvement.
2. **`LOGO_PROVIDER` env var** — if no logo path is provided, the pipeline
   consults `LOGO_PROVIDER`. A matching `ImageProvider` is instantiated and
   asked to `generate(prompt)`; the returned buffer is then fed through the
   same `sharp` resize pipeline as a user file.
3. **Placeholder fallback** — if `LOGO_PROVIDER` is unset or set to `skip`,
   `buildLogoSet` logs a warning and throws
   `AppFactoryError("LOGO_MISSING", recoverable=true)`. Callers (e.g. the
   Copilot Studio recipe) catch the recoverable error and continue without
   branding.

The prompt fed to `provider.generate()` is built from
`FactoryContext.brand.name`, `brand.greeting`, and the recipe id, e.g.:

```
A clean, modern, friendly square app icon for "Contoso Field Service",
evoking the greeting: "Hi, I help with site visits",
for the App Factory recipe "copilot-studio-field-service",
flat vector style, soft gradients, transparent background, no text,
centred subject, 1024x1024
```

A caller may override this entirely by passing `promptHint`.

## Provider env vars

### `LOGO_PROVIDER=azure-openai`

| Env var | Required | Notes |
|---|---|---|
| `AZURE_OPENAI_ENDPOINT` | yes | e.g. `https://my-aoai.openai.azure.com` |
| `AZURE_OPENAI_DEPLOYMENT` | yes | Deployment name for a DALL-E 3 (or equivalent) image model |
| `AZURE_OPENAI_API_KEY` | no | If present, used as `api-key` header |
| `AZURE_OPENAI_API_VERSION` | no | Defaults to `2024-02-15-preview` |
| `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` | no | When `AZURE_OPENAI_API_KEY` is absent, the provider falls back to AAD via `@app-factory/auth-broker`'s `getCredential({ mode: 'chained' })` |

### `LOGO_PROVIDER=openai`

| Env var | Required | Notes |
|---|---|---|
| `OPENAI_API_KEY` | yes | Standard OpenAI API key |
| `OPENAI_IMAGE_MODEL` | no | Defaults to `gpt-image-1` |
| `OPENAI_BASE_URL` | no | Defaults to `https://api.openai.com/v1` |

### `LOGO_PROVIDER=bedrock`

| Env var | Required | Notes |
|---|---|---|
| `AWS_REGION` | yes | e.g. `us-west-2` |
| `BEDROCK_IMAGE_MODEL_ID` | no | Defaults to `stability.stable-image-ultra-v1:0` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | no | The provider uses the default AWS SDK credential chain; supply these env vars only if you aren't using IAM roles, SSO, or `~/.aws/credentials` |

### `LOGO_PROVIDER=skip` (or unset)

No provider is selected. `buildLogoSet` throws `LOGO_MISSING` so callers can
fall back to a placeholder.

## Optional dependencies

The provider SDKs are declared as **optional `peerDependencies`** in
`packages/logo-pipeline/package.json`:

```jsonc
"peerDependencies": {
  "openai": "^4.79.4",
  "@azure/openai": "^2.0.0-beta.3",
  "@aws-sdk/client-bedrock-runtime": "^3.700.0"
},
"peerDependenciesMeta": {
  "openai": { "optional": true },
  "@azure/openai": { "optional": true },
  "@aws-sdk/client-bedrock-runtime": { "optional": true }
}
```

Every provider uses `await import(...)` so an end user who only needs
`LOGO_PROVIDER=skip` (or one specific provider) does not need to install the
others. A missing SDK raises a clear
`AppFactoryError("LOGO_PROVIDER_NOT_INSTALLED", recoverable=true)`.

## Error codes

| Code | Meaning |
|---|---|
| `LOGO_MISSING` | No `logoPath` and no provider selected. |
| `LOGO_PROVIDER_UNKNOWN` | `LOGO_PROVIDER` set to an unrecognised value. |
| `LOGO_PROVIDER_NOT_CONFIGURED` | Required env vars for the chosen provider are missing. |
| `LOGO_PROVIDER_NOT_INSTALLED` | The optional SDK for the chosen provider isn't installed. |
| `LOGO_PROVIDER_HTTP` | The image API returned a non-2xx response. |
| `LOGO_PROVIDER_EMPTY` | The image API returned no usable image payload. |

All of these are `AppFactoryError` instances; everything except
`LOGO_PROVIDER_HTTP` is `recoverable: true`.

## Adding a new provider

1. Create `packages/logo-pipeline/src/providers/<name>.ts` exporting a class
   that implements:

   ```ts
   import type { ImageProvider, LogoProviderId, SelectProviderEnv } from './index.js';

   export class MyProvider implements ImageProvider {
     readonly id: LogoProviderId = '<name>';
     readonly #env: SelectProviderEnv;
     constructor(env: SelectProviderEnv) { this.#env = env; }
     async generate(prompt: string): Promise<Buffer> {
       // 1. Validate required env vars → throw LOGO_PROVIDER_NOT_CONFIGURED
       // 2. await import('your-sdk') → throw LOGO_PROVIDER_NOT_INSTALLED on fail
       // 3. Call the API and return a Buffer of PNG/JPEG bytes
     }
   }
   ```

2. Add `'<name>'` to the `LogoProviderId` union in `providers/index.ts` and
   wire a branch into `selectProvider()` that dynamic-imports your module.

3. List the new SDK under `peerDependencies` + `peerDependenciesMeta` in
   `packages/logo-pipeline/package.json` (mark it `optional`).

4. Add a happy-path + missing-credentials test to
   `packages/logo-pipeline/test/providers.test.ts` using `vi.doMock` to stub
   the SDK — no real network calls.

5. Document the new env vars in this file.

## Conventions

- Logging: each provider uses `createLogger('logo-pipeline:<provider>')` from
  `@app-factory/shared`. Never raw `console`.
- Errors: throw `AppFactoryError` / `AuthError` from `@app-factory/shared`,
  never raw `Error`.
- Module system: ESM only. TypeScript strict mode with
  `noUncheckedIndexedAccess`.
