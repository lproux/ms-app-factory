#!/usr/bin/env tsx
/**
 * Best-effort tear-down for resources matching the smoke run-id prefix
 * (`smoke-YYYYMMDD-<rand>`). NEVER auto-runs — operators invoke this
 * explicitly after a smoke pass or when triaging a failed run.
 *
 * Strategy:
 *   - Authenticate the `az` CLI with the same SP env vars the smoke scripts
 *     use, then list/delete anything in APP_FACTORY_TEST_RG whose name starts
 *     with `smoke-`.
 *   - List Entra app registrations whose displayName starts with
 *     `App Factory Smoke ` and delete them.
 *   - Surface (but don't fail on) Power Platform environments / Copilot
 *     Studio agents — `pac` deletion is interactive in many cases and is
 *     handled manually for now; the script logs guidance instead.
 *
 * The script exits 0 even when individual cleanups fail; the goal is to make
 * a tidy best-effort pass without blocking CI on transient delete races.
 */
import { spawn } from 'node:child_process';
import { createLogger } from '@app-factory/shared';
import { loadSmokeEnv, RUN_ID_PREFIX } from './_env.js';

const log = createLogger('smoke:cleanup');

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${(err as Error).message}` });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function azLogin(env: ReturnType<typeof loadSmokeEnv>): Promise<boolean> {
  const r = await exec('az', [
    'login',
    '--service-principal',
    '--username',
    env.clientId,
    '--password',
    env.clientSecret,
    '--tenant',
    env.tenantId,
    '--only-show-errors',
    '--output',
    'none',
  ]);
  if (r.code !== 0) {
    log.warn({ stderr: r.stderr.trim() }, 'az login failed — skipping az-driven cleanup');
    return false;
  }
  const set = await exec('az', ['account', 'set', '--subscription', env.subscriptionId]);
  if (set.code !== 0) {
    log.warn({ stderr: set.stderr.trim() }, 'az account set failed');
    return false;
  }
  return true;
}

async function deleteSmokeResources(resourceGroup: string): Promise<void> {
  const list = await exec('az', [
    'resource',
    'list',
    '--resource-group',
    resourceGroup,
    '--query',
    `[?starts_with(name, '${RUN_ID_PREFIX}')].{name:name,type:type,id:id}`,
    '--output',
    'json',
  ]);
  if (list.code !== 0) {
    log.warn({ stderr: list.stderr.trim() }, 'failed to list resources');
    return;
  }
  let resources: { name: string; type: string; id: string }[] = [];
  try {
    resources = JSON.parse(list.stdout) as typeof resources;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'unable to parse az resource list output');
    return;
  }
  log.info({ count: resources.length }, 'matched resources for cleanup');
  for (const r of resources) {
    const del = await exec('az', ['resource', 'delete', '--ids', r.id, '--verbose']);
    if (del.code === 0) {
      log.info({ id: r.id, type: r.type }, 'deleted');
    } else {
      log.warn({ id: r.id, stderr: del.stderr.trim() }, 'delete failed (continuing)');
    }
  }
}

async function deleteSmokeEntraApps(): Promise<void> {
  const list = await exec('az', [
    'ad',
    'app',
    'list',
    '--display-name',
    'App Factory Smoke ',
    '--query',
    '[].{appId:appId,displayName:displayName}',
    '--output',
    'json',
  ]);
  if (list.code !== 0) {
    log.warn({ stderr: list.stderr.trim() }, 'failed to list Entra apps');
    return;
  }
  let apps: { appId: string; displayName: string }[] = [];
  try {
    apps = JSON.parse(list.stdout) as typeof apps;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'unable to parse Entra app list');
    return;
  }
  log.info({ count: apps.length }, 'matched Entra apps for cleanup');
  for (const a of apps) {
    const del = await exec('az', ['ad', 'app', 'delete', '--id', a.appId]);
    if (del.code === 0) {
      log.info({ appId: a.appId, displayName: a.displayName }, 'deleted Entra app');
    } else {
      log.warn({ appId: a.appId, stderr: del.stderr.trim() }, 'Entra app delete failed');
    }
  }
}

async function main(): Promise<void> {
  const env = loadSmokeEnv();
  log.info(
    { resourceGroup: env.resourceGroup, ppEnv: env.powerPlatformEnvironment },
    'starting best-effort smoke cleanup',
  );

  const loggedIn = await azLogin(env);
  if (loggedIn) {
    await deleteSmokeResources(env.resourceGroup);
    await deleteSmokeEntraApps();
  }

  log.info(
    'Power Platform / Copilot Studio agents must be cleaned manually via `pac solution delete` ' +
      'or the Power Apps maker portal — interactive auth not assumed here.',
  );
  log.info('cleanup pass complete (best-effort)');
}

main().catch((err: unknown) => {
  log.error({ err: (err as Error).message }, 'cleanup fatal — exiting 0 anyway');
  process.exit(0);
});
