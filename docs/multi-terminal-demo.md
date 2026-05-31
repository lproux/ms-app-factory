# Multi-terminal orchestrator demo

`tools/multi-terminal-demo.ts` is a runnable demonstration of the
`@app-factory/orchestrator` package. It spawns four named tmux worker
windows that simulate the long-running CLIs the App Factory drives
(`pac`, `atk`, `az`, `gh copilot`), then polls each worker's pane output
and prints a synthesized status log every 2 seconds. It exits cleanly
once every worker reports completion.

The demo is **local-only**: workers run `sleep`/`echo` loops in a
plain `bash` shell. **No Azure, M365, or Power Platform state is
mutated.**

## Prerequisites

- `tmux` on `PATH` (`tmux -V` should print a version)
- Node.js >= 22 (the demo relies on `--experimental-strip-types`, on by
  default from Node 22.18)
- `pnpm install` at the repo root (installs `tsx` for the orchestrator
  package — see note below on why we prefer Node's native loader)
- A real terminal session (the demo writes status lines to stdout while
  the workers run inside the `app-factory` tmux session)

## Run it

Preferred (uses Node 22's built-in TypeScript stripping, zero loader
dependencies):

```bash
pnpm --filter @app-factory/orchestrator demo:multi-terminal
```

Or, equivalently, from the repo root:

```bash
node --experimental-strip-types --experimental-transform-types \
     --no-warnings tools/multi-terminal-demo.ts
```

> **Note on `pnpm tsx tools/multi-terminal-demo.ts`:** tsx 4.19+ trips
> over the `unicorn-magic` package (transitive dep of `execa`) because
> tsx's CJS resolver does not honor `exports`-only packages. This is an
> upstream tsx bug. We still keep `tsx` as a devDep for direct script
> debugging, but the supported launcher is the Node command above.

In a second terminal, watch the workers live:

```bash
tmux attach -t app-factory
```

Detach with `Ctrl-b d`. The demo will tear down its windows when it
finishes.

### Expected runtime

The simulated workloads sleep for 4 - 7 seconds each, and the master
polls on a 2 s cadence. End-to-end the demo typically completes in
**8 - 12 seconds**.

### Sample output

```
[master 2026-05-31 00:21:29] spawning 4 workers in tmux session "app-factory"
[master 2026-05-31 00:21:29] watch live with: tmux attach -t app-factory
[master 2026-05-31 00:21:31] pac=run:"[pac] step 3/5" | atk=run:"[atk] step 2/6" | az=run:"[az] step 2/4" | gh-copilot=run:"[gh-copilot] step 2/7"
[master 2026-05-31 00:21:33] pac=run:"[pac] step 5/5" | atk=run:"[atk] step 4/6" | az=run:"[az] step 4/4" | gh-copilot=run:"[gh-copilot] step 4/7"
[master 2026-05-31 00:21:35] pac=DONE:"<prompt>" | atk=DONE:"<prompt>" | az=DONE:"<prompt>" | gh-copilot=run:"[gh-copilot] step 6/7"
[master 2026-05-31 00:21:37] pac=DONE:"<prompt>" | atk=DONE:"<prompt>" | az=DONE:"<prompt>" | gh-copilot=DONE:"<prompt>"
[master 2026-05-31 00:21:37] all workers complete; cleaning up windows
[master 2026-05-31 00:21:37] exit ok
```

`DONE` in the master's status log is the orchestrator's view (it saw the
`[name] FINISHED` line in the pane and flipped the worker to completed).
`<prompt>` is shorthand for whatever the shell prompt happens to be on
the bottom line after the workload exits.

## Demonstrating recovery

Pass `--kill <name>` to kill a worker mid-flight and exercise the
`spawn()` re-spawn path. Valid names: `pac`, `atk`, `az`, `gh-copilot`.

```bash
node --experimental-strip-types --experimental-transform-types \
     --no-warnings tools/multi-terminal-demo.ts --kill az
```

The master will kill the named worker on the first poll tick, then
re-spawn it with the same name and resume polling. The status line for
the respawned worker will reset (step counter restarts), confirming the
fresh process.

## How it works

- `spawn(command, { session, name })` (from
  `packages/orchestrator/src/tmux.ts`) creates a new tmux window in the
  shared `app-factory` session.
- `send(keys)` types the workload script into the pane and presses
  Enter.
- `capture(lines)` reads the visible scrollback for the master to inspect.
- `kill()` calls `tmux kill-window`. Re-running `spawn()` with the same
  name produces a clean new window — that is the recovery path the
  `--kill` flag exercises.

For an automated verification of this behavior, see
`packages/orchestrator/test/tmux-spawn.test.ts`, which skips itself if
`tmux` is not on `PATH`.
