#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@app-factory/shared';

const log = createLogger('skill-adapter:copilot-cli');

export const EXTENSION_SCRIPT = `#!/usr/bin/env bash
# gh-app-factory — a gh extension that forwards to the App Factory CLI.
#
# Usage:
#   gh app-factory build --recipe copilot-studio-support-bot --plan
#   gh app-factory list-recipes
#
# Requires the app-factory CLI on PATH (or AF_BIN env var to override).

set -euo pipefail

AF_BIN="\${AF_BIN:-app-factory}"

if ! command -v "$AF_BIN" >/dev/null 2>&1; then
  echo "app-factory binary not found. Set AF_BIN or run: pnpm --filter @app-factory/cli build && pnpm --filter @app-factory/cli link" >&2
  exit 127
fi

exec "$AF_BIN" "$@"
`;

export const EXTENSION_MANIFEST = `name: app-factory
description: App Factory — Copilot Studio + Teams provisioner (delegates to local app-factory CLI)
`;

export interface InstallGhOptions {
  extensionsDir?: string;
}

export async function installGhExtension(opts: InstallGhOptions = {}): Promise<string> {
  const dir = opts.extensionsDir ?? path.join(os.homedir(), '.local', 'share', 'gh', 'extensions', 'gh-app-factory');
  await fs.mkdir(dir, { recursive: true });
  const scriptPath = path.join(dir, 'gh-app-factory');
  await fs.writeFile(scriptPath, EXTENSION_SCRIPT, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'extension.yml'), EXTENSION_MANIFEST, 'utf8');
  log.info({ scriptPath }, 'gh extension installed (invoke via `gh app-factory ...`)');
  return scriptPath;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  installGhExtension()
    .then((p) => console.log(`installed: ${p}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
