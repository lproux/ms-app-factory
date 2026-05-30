import { createLogger, ProvisioningError } from '@app-factory/shared';
import { solutionImport, copilotPublish, solutionPublish, type SolutionImportResult } from './pac.js';

const log = createLogger('copilot-studio:publish');

export interface ImportSolutionOptions {
  envId?: string;
  asyncWaitTimeMins?: number;
  useTmux?: boolean;
  cwd?: string;
}

export async function importSolution(
  zip: string,
  opts: ImportSolutionOptions = {},
): Promise<SolutionImportResult> {
  log.info({ zip, envId: opts.envId }, 'importing solution');
  return solutionImport(zip, {
    envId: opts.envId,
    activatePlugins: true,
    asyncWaitTimeMins: opts.asyncWaitTimeMins ?? 30,
    useTmux: opts.useTmux ?? true,
    cwd: opts.cwd,
  });
}

export interface PublishAgentOptions {
  envId?: string;
  /** Optional Direct Line/REST endpoint override for the Copilot Studio publish API. */
  publishUrl?: string;
  /** Bearer token for the publish API (only required when invoking the REST endpoint directly). */
  bearerToken?: string;
}

export interface PublishAgentResult {
  agentId: string;
  invokeUrl?: string;
  channels: string[];
}

export async function publishAgent(
  agentId: string,
  opts: PublishAgentOptions = {},
): Promise<PublishAgentResult> {
  log.info({ agentId, envId: opts.envId }, 'publishing agent');
  const pacResult = await copilotPublish(opts.envId);
  if (pacResult === null) {
    // pac copilot subcommand absent — fall back to the Power Platform "solution publish" path
    // (publishes customizations including the bot definitions in the imported solution).
    await solutionPublish(opts.envId);
  }
  let invokeUrl: string | undefined;
  if (opts.publishUrl && opts.bearerToken) {
    const res = await fetch(opts.publishUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.bearerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agentId }),
    });
    if (!res.ok) {
      throw new ProvisioningError(`publish API ${opts.publishUrl} failed: ${res.status}`);
    }
    const body = (await res.json()) as { invokeUrl?: string; endpoint?: string };
    invokeUrl = body.invokeUrl ?? body.endpoint;
  }
  invokeUrl = invokeUrl ?? (await getInvokeUrl(agentId));
  return { agentId, invokeUrl, channels: ['web'] };
}

export async function getInvokeUrl(agentId: string): Promise<string | undefined> {
  // Without an explicit Direct Line secret, we synthesize the documented public URL pattern.
  // The actual Direct Line key resolution happens via the secret bundle (A12).
  if (!agentId) return undefined;
  return `https://directline.botframework.com/v3/directline/conversations?agentId=${encodeURIComponent(agentId)}`;
}
