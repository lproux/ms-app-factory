import { execa, type Options as ExecaOptions } from 'execa';
import {
  PortalRequiredError,
  ProvisioningError,
  createLogger,
} from '@app-factory/shared';
import { spawn, type SpawnOptions, type WorkerHandle } from './tmux.js';
import { shellQuoteSingle } from './shell.js';

const log = createLogger('orchestrator:cli-runner');

// ---------------------------------------------------------------------------
// Internal version helpers (module-private — no longer duplicated per wrapper).
// ---------------------------------------------------------------------------

function parseVersion(s: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) return [0, 0, 0];
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function isVersionAtLeast(actual: string, min: string): boolean {
  const a = parseVersion(actual);
  const m = parseVersion(min);
  for (let i = 0; i < 3; i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export type ExecLike = (
  file: string,
  args: string[],
  opts?: ExecaOptions,
) => ReturnType<typeof execa>;

export type SpawnLike = (
  command: string,
  opts?: SpawnOptions,
) => Promise<WorkerHandle>;

export interface MakeCliWrapperOptions {
  /** The binary name on PATH (e.g. `atk`, `agent365`). Also used as the
   *  default `[done:N]` marker namespace (`${bin}-done`). */
  bin: string;
  /** Human-readable name for log messages and error text. */
  name: string;
  /** Optional minimum version; older versions only `warn`. */
  minVersion?: string;
  /** `npm i -g …` style hint surfaced in PortalRequiredError. */
  installHint: string;
  /** Portal/docs URL surfaced when the binary is missing. */
  portalUrl?: string;
  /** Override the `[<marker>:N]` echo marker; defaults to `${bin}-done`. */
  marker?: string;
}

export interface DetectVersionOptions {
  exec?: ExecLike;
}

export interface CliRunInTmuxOptions {
  /** tmux window name. */
  name: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Regex that, when matched, confirms a successful run even if the output
   *  also contains scary words like "error". Defaults to `/./` (always-matches). */
  successRegex?: RegExp;
  /** Output marker that triggers a ProvisioningError even with exit 0. */
  failureRegex?: RegExp;
  timeoutMs?: number;
  spawnFn?: SpawnLike;
}

export interface CliRunOptions {
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  exec?: ExecLike;
  /** Optional friendly name used in ProvisioningError messages. */
  name?: string;
}

export interface CliWrapper {
  /** Probe `<bin> --version`. Cached on success. Throws PortalRequiredError on miss. */
  detectVersion(opts?: DetectVersionOptions): Promise<string>;
  /** Reset the cached version (test seam). */
  resetVersionCache(): void;
  /** Warn if `version` < `minVersion`. No-op when `minVersion` was not provided. */
  assertMinVersion(version: string): Promise<void>;
  /** Drive a long-running invocation via tmux. Returns the captured pane buffer. */
  runInTmux(opts: CliRunInTmuxOptions): Promise<string>;
  /** Drive a short invocation directly via execa. Throws ProvisioningError on non-zero. */
  run(opts: CliRunOptions): Promise<{ stdout: string; stderr: string }>;
  /** Echo back the constructor inputs (handy for tests + introspection). */
  readonly config: Readonly<{
    bin: string;
    name: string;
    minVersion: string | undefined;
    installHint: string;
    portalUrl: string | undefined;
    marker: string;
  }>;
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

export function makeCliWrapper(options: MakeCliWrapperOptions): CliWrapper {
  const {
    bin,
    name,
    minVersion,
    installHint,
    portalUrl,
  } = options;
  const marker = options.marker ?? `${bin}-done`;
  const markerRegex = new RegExp(`\\[${escapeRegex(marker)}:(\\d+)\\]`);
  const markerProbeRegex = new RegExp(`\\[${escapeRegex(marker)}:\\d+\\]`);

  let _verifiedVersion: string | undefined;

  async function detectVersion(opts: DetectVersionOptions = {}): Promise<string> {
    if (_verifiedVersion) return _verifiedVersion;
    const exec = opts.exec ?? (execa as unknown as ExecLike);
    try {
      const result = await exec(bin, ['--version'], { reject: false });
      if (result.exitCode !== 0) {
        throw makePortalError(
          `${name} not available (exit ${result.exitCode}). Install with: ${installHint}`,
          {
            stderr: result.stderr,
            stdout: result.stdout,
            install: installHint,
          },
        );
      }
      const version = String(result.stdout ?? '').trim();
      _verifiedVersion = version;
      await assertMinVersion(version);
      log.info({ bin, version }, `${name} detected`);
      return version;
    } catch (err) {
      if (err instanceof PortalRequiredError) throw err;
      throw makePortalError(
        `${name} not on PATH. Install with: ${installHint}`,
        { install: installHint },
        err,
      );
    }
  }

  function makePortalError(
    message: string,
    details: Record<string, unknown>,
    cause?: unknown,
  ): PortalRequiredError {
    const opts: ConstructorParameters<typeof PortalRequiredError>[2] = { details };
    if (cause !== undefined) opts.cause = cause;
    // PortalRequiredError requires a string portalUrl. When the caller did not
    // provide one we fall back to a stable, non-empty marker so consumers can
    // still distinguish PortalRequiredError without crashing the constructor.
    return new PortalRequiredError(message, portalUrl ?? '', opts);
  }

  async function assertMinVersion(version: string): Promise<void> {
    if (!minVersion) return;
    if (!isVersionAtLeast(version, minVersion)) {
      log.warn(
        { bin, version, required: minVersion },
        `${name} version older than expected; behavior may differ`,
      );
    }
  }

  async function runInTmux(opts: CliRunInTmuxOptions): Promise<string> {
    const spawnFn = opts.spawnFn ?? spawn;
    const failureRegex = opts.failureRegex ?? /(error|failed|✖|✗)\b/i;
    const successRegex = opts.successRegex ?? /./;
    const timeoutMs = opts.timeoutMs ?? 20 * 60_000;

    const argStr = opts.args.map(shellQuoteSingle).join(' ');
    const cmd = `bash -lc ${shellQuoteSingle(
      `${bin} ${argStr} 2>&1; echo "[${marker}:$?]"`,
    )}`;
    log.info(
      { bin, name: opts.name, args: opts.args, cwd: opts.cwd },
      `spawning ${name} worker`,
    );

    const spawnOpts: SpawnOptions = { name: opts.name };
    if (opts.cwd !== undefined) spawnOpts.cwd = opts.cwd;
    if (opts.env !== undefined) spawnOpts.env = opts.env;

    const handle = await spawnFn(cmd, spawnOpts);
    try {
      const buf = await handle.waitFor(markerProbeRegex, { timeoutMs, pollMs: 2_000 });
      const m = markerRegex.exec(buf);
      const exitCode = m ? Number(m[1]) : -1;
      if (exitCode !== 0) {
        throw new ProvisioningError(`${bin} ${opts.name} failed (exit ${exitCode})`, {
          details: { args: opts.args, tail: buf.slice(-2000) },
        });
      }
      if (failureRegex.test(buf) && !successRegex.test(buf)) {
        throw new ProvisioningError(
          `${bin} ${opts.name} reported failure markers in output`,
          { details: { args: opts.args, tail: buf.slice(-2000) } },
        );
      }
      log.info({ bin, name: opts.name }, `${name} completed`);
      return buf;
    } catch (err) {
      if (err instanceof ProvisioningError) throw err;
      throw new ProvisioningError(`${bin} ${opts.name} did not complete`, {
        cause: err,
        details: { args: opts.args },
      });
    }
  }

  async function run(opts: CliRunOptions): Promise<{ stdout: string; stderr: string }> {
    const exec = opts.exec ?? (execa as unknown as ExecLike);
    const friendly = opts.name ?? bin;
    log.info({ bin, name: friendly, args: opts.args, cwd: opts.cwd }, `invoking ${name}`);
    let cleanedEnv: Record<string, string> | undefined;
    if (opts.env !== undefined) {
      cleanedEnv = {};
      for (const [k, v] of Object.entries(opts.env)) {
        if (v !== undefined) cleanedEnv[k] = v;
      }
    }
    const execaOpts: ExecaOptions = {
      reject: false,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(cleanedEnv !== undefined ? { env: cleanedEnv } : {}),
    };
    const result = await exec(bin, opts.args, execaOpts);
    const stdout = String(result.stdout ?? '');
    const stderr = String(result.stderr ?? '');
    if (result.exitCode !== 0) {
      throw new ProvisioningError(`${bin} ${friendly} failed (exit ${result.exitCode})`, {
        details: {
          args: opts.args,
          stderr: stderr.slice(-2000),
          stdout: stdout.slice(-2000),
        },
      });
    }
    return { stdout, stderr };
  }

  return {
    detectVersion,
    resetVersionCache: () => {
      _verifiedVersion = undefined;
    },
    assertMinVersion,
    runInTmux,
    run,
    config: Object.freeze({
      bin,
      name,
      minVersion,
      installHint,
      portalUrl,
      marker,
    }),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
