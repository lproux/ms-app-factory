import { AppFactoryError, createLogger } from '@app-factory/shared';
import { spawn, type SpawnOptions, type WorkerHandle } from '@app-factory/orchestrator';

const log = createLogger('azure-ops:pim');

export type SpawnFn = (command: string, opts?: SpawnOptions) => Promise<WorkerHandle>;

export interface ActivatePimOptions {
  roleName: string;
  justification: string;
  session?: string;
  spawnFn?: SpawnFn;
  timeoutMs?: number;
}

export interface ActivatePimResult {
  alreadyActive: boolean;
  rawOutput: string;
}

/**
 * Activate (or confirm) a PIM-elevated Entra role through the Azure CLI.
 *
 * Runs interactively inside the `app-factory` tmux session because Microsoft
 * Entra elevation prompts (device-code, MFA) require an attached terminal.
 *
 * **Attach instructions:**
 * ```
 * tmux attach -t app-factory   # then switch to the `az-pim` window
 * ```
 * The orchestrator logs any device-code / verification URL via
 * `logger.warn` so the master orchestrator can surface it.
 */
export async function activatePim(opts: ActivatePimOptions): Promise<ActivatePimResult> {
  const spawnFn = opts.spawnFn ?? spawn;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  const session = opts.session ?? 'app-factory';

  const justification = opts.justification.replace(/'/g, "'\\''");
  const role = opts.roleName.replace(/'/g, "'\\''");

  const script = [
    'set -o pipefail',
    'echo "[pim] checking az login state"',
    'az account show >/dev/null 2>&1 || az login --use-device-code',
    'echo "[pim] attempting PIM activation"',
    `az rest --method post --url 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignmentScheduleRequests' --body '{"action":"selfActivate","justification":"${justification}","roleDefinitionId":"<role-id-resolved-at-runtime>","directoryScopeId":"/","principalId":"<self>","scheduleInfo":{"startDateTime":null,"expiration":{"type":"AfterDuration","duration":"PT1H"}}}' 2>&1 | tee /tmp/pim.out || true`,
    `az role assignment list --include-inherited --query "[?roleDefinitionName=='${role}']" -o table || true`,
    'echo "[pim] activation step finished"',
  ].join(' && ');

  const cmd = `bash -lc ${shellSingle(script)}`;
  log.info({ role: opts.roleName, justification: opts.justification }, 'spawning PIM activation worker');

  const handle = await spawnFn(cmd, { name: 'az-pim', session });

  try {
    const buf = await handle.waitFor(
      /Role activation succeeded|already active|active for|\[pim\] activation step finished/i,
      { timeoutMs, pollMs: 2_000 },
    );
    const alreadyActive = /already active|active for/i.test(buf);
    log.info({ alreadyActive }, 'PIM activation completed');
    return { alreadyActive, rawOutput: buf };
  } catch (err) {
    throw new AppFactoryError('PIM_ACTIVATION', `PIM activation for ${opts.roleName} timed out or failed`, {
      cause: err,
      details: { roleName: opts.roleName },
    });
  } finally {
    try {
      const tail = await handle.capture(200);
      if (/Code [A-Z0-9]{6,}/.test(tail)) {
        log.warn({ tail: tail.slice(-1000) }, 'interactive elevation prompt observed in pane');
      }
    } catch {
      /* ignore */
    }
  }
}

function shellSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
