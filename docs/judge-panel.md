# Judge panel

Each artifact produced by the factory is reviewed by a multi-model judge
panel before it is considered shippable. Three judges, four personas,
configurable voting policy, and an optional auto-improve loop.

Source files:

- `packages/judge-panel/src/panel.ts`
- `packages/judge-panel/src/voting.ts`
- `packages/judge-panel/src/auto-improve.ts`
- `packages/judge-panel/src/personas.ts`
- `packages/judge-panel/src/judges/claude.ts`
- `packages/judge-panel/src/judges/copilot.ts`
- `packages/judge-panel/src/judges/copilot-studio.ts`

## The three judges

### Claude (`makeClaudeJudge`)

- Uses `@anthropic-ai/sdk` via dynamic import.
- Reads `ANTHROPIC_API_KEY` (or `opts.apiKey`). Missing key raises
  `AppFactoryError('CLAUDE_JUDGE_NO_KEY', …, { recoverable: true })`.
- Default model: `claude-opus-4-5`. Override with `opts.model`.
- Failures: `CLAUDE_SDK_UNAVAILABLE` (recoverable) when the SDK does not
  load; `CLAUDE_SDK_SHAPE` (recoverable) when the imported module is
  missing the expected constructor.
- Submits the persona prompt as a single user message with `max_tokens:
  1024`, then joins all text blocks from the response and runs
  `parseVerdict`.

### GH Copilot (`makeGhCopilotJudge`)

- Uses the `gh` CLI through a tmux worker. Defaults to `gh` on `PATH`;
  override with `opts.ghBin`.
- Spawns `gh --version` first to confirm the binary responds; failure
  becomes `AppFactoryError('GH_COPILOT_UNAVAILABLE', …, { recoverable:
  true })`.
- Submits the prompt via `gh copilot suggest -t shell <<'AF_JUDGE_EOF' ...
  AF_JUDGE_EOF`. Any literal `AF_JUDGE_EOF` in the prompt is replaced with
  `AF_JUDGE_EOF_X` to keep the heredoc intact.
- Waits up to 60s for either a prompt-return (`$`) or `gh copilot:` line,
  then parses the tail window after the closing `AF_JUDGE_EOF`. Timeout:
  `AppFactoryError('GH_COPILOT_TIMEOUT', …, { recoverable: true })`.
- The tmux worker is killed in `finally`, even on parse failure.

### Copilot Studio (`makeCopilotStudioJudge`)

- Talks to a Copilot Studio agent over Direct Line v3.
- Reads `COPILOT_STUDIO_JUDGE_SECRET` (or `opts.directLineSecret`).
  Missing secret raises `AppFactoryError('CS_JUDGE_NO_SECRET', …, {
  recoverable: true })`.
- Conversation lifecycle: `POST /v3/directline/conversations` →
  `POST .../activities` → poll `GET .../activities` until either a bot
  reply lands or `POLL_BUDGET_MS = 10_000` elapses (`POLL_INTERVAL_MS =
  750`).
- Failures: `CS_JUDGE_HTTP` (any non-2xx, recoverable) and
  `CS_JUDGE_TIMEOUT` (no reply in time, recoverable).
- Default base URL: `https://directline.botframework.com`.

All three judges produce the same `Verdict` shape via the shared
`parseVerdict` helper.

## The four personas

Each persona has a focused brief (see `personas.ts`):

- **architect** — coherence, design, error handling.
- **security** — auth, secrets, prompt-injection, scopes. Hard veto by
  default policy.
- **cost** — sizing, SKUs, regions, idle exposure.
- **ux** — clarity, brand, accessibility.

The persona is selected at judge construction time (`makeClaudeJudge({
persona })`, etc). The WBS panels in `runCopilotStudio` and `runTeamsApp`
build a 12-judge panel: each of the four personas wired to each of the
three judges.

The persona prompt ends with a strict JSON contract:

```
{"approved": boolean, "score": number (0..1),
 "reason": string, "repairNotes": string}
```

`parseVerdict` accepts a fenced ```` ```json ```` block, a bare object, or
the first balanced `{...}` it finds. If parsing fails, `approved` defaults
to `false` and `reason` to `"no reason provided"`.

## Voting

`tally(verdicts, policy)` in `voting.ts`:

1. Drop judges whose id ends with `:unavailable` (those are the synthetic
   verdicts the panel creates for recoverable-error judges).
2. Count `approvals` and `rejections` from the remaining `counted`.
3. If `counted.length < quorum` (default
   `Math.ceil(verdicts.length / 2)`): vetoed, with a quorum note appended
   to `repairNotes`.
4. If any `counted` rejection has a persona in `policy.vetoOn` (default
   `['security']`): vetoed.
5. Otherwise apply `policy.tieBreaker`:
   - `majority` (default): vetoed when `rejections >= approvals`.
   - `architect`: defers to the architect judge's verdict if one is
     present; otherwise falls back to `majority`.
   - `unanimous`: vetoed if `rejections > 0`.

`repairNotes` is the deduped, prefixed list of `[<judge>/<persona>] <note>`
lines from every non-approving verdict; this is what `autoImprove` feeds
back into the regeneration callback.

## Tie-breaks in practice

- A 2-2 split with `majority` → vetoed (tie counts as not-passing).
- A 2-2 split with `architect` and an architect verdict that approved →
  not vetoed.
- A 6-6 split with `unanimous` → vetoed.

## `autoImprove`

`autoImprove({ panel, regenerate, initial, maxRounds })`
(`auto-improve.ts`) loops:

1. `panel.review(current.artifact)`.
2. If not vetoed → return `{ input, artifact, rounds }`.
3. If `maxRounds` set and reached → throw `JudgeVetoError` with the
   dissenting votes.
4. Otherwise call `regenerate(input, repairNotes)`, replace `current`,
   loop.

`maxRounds` is optional; an unbounded loop will run until the panel
clears or `regenerate` throws.

`regenerate` is the caller's hook to produce a new artifact informed by
the panel's repair notes. The factory does not yet wire this in for the
default A11/B13 steps (they call `panel.review` once and store the
result on the run context); add `autoImprove` around your own
recipe-specific artifact generators when you want self-healing runs.

## Constructing a panel manually

```ts
import {
  JudgePanel,
  makeClaudeJudge,
  makeGhCopilotJudge,
  makeCopilotStudioJudge,
} from '@app-factory/judge-panel';

const panel = new JudgePanel({
  judges: [
    makeClaudeJudge({ persona: 'architect' }),
    makeClaudeJudge({ persona: 'security' }),
    makeGhCopilotJudge({ persona: 'cost' }),
    makeCopilotStudioJudge({ persona: 'ux' }),
  ],
  policy: { vetoOn: ['security'], tieBreaker: 'architect' },
});

const result = await panel.review({
  kind: 'cs-agent',
  id: 'sample',
  summary: 'minimal agent for sanity check',
});
```

`JudgePanel` requires at least one judge or it throws
`AppFactoryError('JUDGE_PANEL_EMPTY')`. `reviewOrThrow(artifact)` is a
thin wrapper around `review` that converts a vetoed result into a
`JudgeVetoError` (see [troubleshooting.md](./troubleshooting.md)).

## What the WBS does with the result

Both `runCopilotStudio` (step A11) and `runTeamsApp` (step B13) catch
`JudgeVetoError` and record the dissent in `ctx.warnings` rather than
aborting the run. The panel result is stored on the run context but does
not currently block emission of secrets (A12 / B14). Use `autoImprove`
or your own pre-emit check when you need a hard gate.
