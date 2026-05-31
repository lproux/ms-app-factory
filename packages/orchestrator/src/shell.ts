/**
 * POSIX single-quote shell escaping helper. Wraps `s` in single quotes and
 * encodes any embedded single quotes as `'\''` (close, escaped-quote, reopen).
 *
 * Historically this body lived as `shellSingle` / `shellEscape` in four
 * different packages (`orchestrator/tmux.ts`, `azure-ops/pim.ts`,
 * `agent-365/cli.ts`, `teams-app/atk.ts`). Consolidating here removes the
 * drift surface and gives downstream callers a single canonical helper.
 */
export function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
