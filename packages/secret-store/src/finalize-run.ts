/**
 * packages/secret-store/src/finalize-run.ts
 *
 * Shared "emit" tail used by the A12 (Copilot Studio) and B14 (Teams app)
 * WBS steps. Both stages used to:
 *   1. build the SecretStore (with optional Azure Key Vault adapter),
 *   2. write every queued secret into it,
 *   3. build the markdown paste bundle.
 *
 * `finalizeRun` extracts that block. It takes a `RunAccumulator` —
 * the shared subset of the per-track context (`artifacts`, `secrets`,
 * `warnings`) — and the `FactoryContext.emit` shape that controls
 * Key Vault wiring and the `revealSecrets` toggle. Callers pass the
 * track-specific `title` and (B14 only) the cost optimizer suggestions.
 */

import { createLogger, type AuthMode, type ArtifactRef, type FactoryContext, type SecretRef } from '@app-factory/shared';
import { getCredential } from '@app-factory/auth-broker';
import { buildSecretStore } from './index.js';
import { buildPasteBundle, type CostSuggestion } from './paste.js';

const log = createLogger('secret-store:finalize-run');

/**
 * Minimal context shape consumed by `finalizeRun`. Both A12 (`CSCtx`)
 * and B14 (`TACtx`) already satisfy this — they each maintain
 * `artifacts`, `secrets`, and `warnings` accumulators on their per-step
 * context.
 */
export interface RunAccumulator {
  artifacts: ArtifactRef[];
  secrets: { ref: SecretRef; value: string }[];
  warnings: string[];
}

export interface FinalizeRunArgs {
  fctx: FactoryContext;
  ctx: RunAccumulator;
  /**
   * Artifact-kind tag echoed into log lines (e.g. `'cs-agent'`,
   * `'teams-app'`). Purely diagnostic — does not affect the bundle.
   */
  kind: string;
  /** Title rendered as the H1 of the paste bundle. */
  title: string;
  /**
   * Track-specific cost optimizer output. Track A (CS) does not have a
   * cost optimizer today, so this is optional and omitted when undefined
   * or empty.
   */
  costSuggestions?: CostSuggestion[];
}

export interface FinalizeRunResult {
  pasteBundle: string;
}

/**
 * Build the SecretStore, persist every queued secret, and render the
 * paste bundle. The SecretStore picks up an Azure Key Vault adapter
 * only when `fctx.emit.keyVault` is set — otherwise it falls back to
 * the local OS keyring (no credential is constructed in
 * that case so the auth-broker isn't probed unnecessarily).
 */
export async function finalizeRun(args: FinalizeRunArgs): Promise<FinalizeRunResult> {
  const { fctx, ctx, kind, title, costSuggestions } = args;

  const vaultCred = fctx.emit.keyVault
    ? getCredential({
        mode: fctx.auth.mode as AuthMode,
        tenantId: fctx.tenant?.tenantId,
      })
    : undefined;
  const store = await buildSecretStore({
    keyVaultUrl: fctx.emit.keyVault,
    credential: vaultCred,
  });
  for (const s of ctx.secrets) {
    await store.set(s.ref.scope, s.ref.name, s.value);
  }

  const items = ctx.secrets.map((s) => ({
    scope: s.ref.scope,
    name: s.ref.name,
    value: s.value,
    ...(s.ref.description !== undefined ? { description: s.ref.description } : {}),
  }));

  const pasteBundle = buildPasteBundle(items, {
    title,
    artifacts: ctx.artifacts,
    warnings: ctx.warnings,
    revealSecrets: fctx.emit.revealSecrets === true,
    ...(costSuggestions && costSuggestions.length > 0 ? { costSuggestions } : {}),
  });

  log.info(
    {
      kind,
      keyVault: fctx.emit.keyVault ? 'set' : 'none',
      secretCount: ctx.secrets.length,
      revealSecrets: fctx.emit.revealSecrets === true,
    },
    'finalizeRun complete',
  );

  return { pasteBundle };
}
