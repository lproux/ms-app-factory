# Judge-panel shapes

The judge panel is configurable. `FactoryContext.judge.shape` picks one of
three fan-out shapes and `FactoryContext.judge.maxRounds` bounds the
auto-improve loop. Both have safe defaults (`cross-model`, `3`) so existing
recipes keep their behaviour, but routine runs can dial down to `compact` /
`1` and security-sensitive runs can opt in to `full` / `5+`.

```ts
// packages/shared/src/types.ts
judge: z.object({
  shape: z.enum(['compact', 'cross-model', 'full']).default('cross-model'),
  maxRounds: z.number().int().min(1).max(10).default(3),
})
```

The helper `buildJudgePanel({ shape, personas, policy? })` lives in
`@app-factory/judge-panel` and returns a ready-to-use `JudgePanel`. Both
A11 (Copilot Studio) and B13 (Teams app) call it instead of hand-rolling
the panel — see `packages/copilot-studio/src/index.ts` and
`packages/teams-app/src/index.ts`.

## The three shapes

### `compact` — one judge per model, all personas in one prompt

```
3 models × 1 round-trip × 4 personas-per-call = 3 LLM calls / review
                                              × maxRounds (default 3)
                                              = up to 9 calls / panel
```

Implementation:

- One `CombinedJudge` per model (`makeClaudeCombinedJudge`,
  `makeGhCopilotCombinedJudge`, `makeCopilotStudioCombinedJudge`).
- Each combined judge prompts the LLM with EVERY persona brief in a single
  message, then asks for a `{ "verdicts": { "architect": {...}, ... } }`
  JSON bundle.
- `parseCombinedVerdicts` fans the bundle back into one `Verdict` per
  persona, so the rest of the voting pipeline is identical to the other
  shapes — including `vetoOn: ['security']` and tie-break logic.
- Per-persona reasoning is preserved; only the network/inference cost is
  collapsed.

When to pick: routine recipes (`teams-bot-basic`, `teams-tab-basic`,
`copilot-studio-support-bot` for low-risk tenants), CI smoke runs, anything
where the LLM-call budget matters more than redundant cross-model
disagreement.

Trade-off: a single network blip wipes out all four persona verdicts for
that model. The other two models still cover, so a 2-of-3 quorum still
holds.

### `cross-model` — every persona × every model (default)

```
4 personas × 3 models × 1 prompt-each = 12 LLM calls / review
                                      × maxRounds (default 3)
                                      = up to 36 calls / panel
```

Implementation: identical to the historical default — one
`makeClaudeJudge({ persona })` + one `makeGhCopilotJudge({ persona })` + one
`makeCopilotStudioJudge({ persona })` per persona.

When to pick: regulated/customer-facing recipes, any flow that already pays
for cross-model disagreement detection. This is the safe default and the
behaviour all pre-J5 fixtures expect.

Trade-off: ~4× the LLM cost of `compact` for substantially the same
verdict coverage. Justified when an outlier model catching a defect the
others miss is worth the spend.

### `full` — every persona × every registered factory

```
4 personas × (3 base + N extras) × 1 prompt-each = (12 + 4N) LLM calls / review
                                                 × maxRounds
```

Implementation: same as `cross-model` plus any per-persona factories passed
via `factories.extras`. Reserved for security-sensitive deployments where
specialised judges (e.g. a Foundry-hosted policy model, a custom audit
agent) need a seat on every persona.

When to pick: `teams-agent-365` for tenants with hard compliance gates;
ad-hoc audit runs against a baseline.

Trade-off: most expensive shape. Use sparingly.

## Cost math (illustrative)

Assume $0.01 per LLM call as a rough mid-tier blend (claude-opus + gh
copilot + Direct Line). One A11 or B13 invocation under the historical
default would cost up to:

```
36 calls × $0.01 = $0.36 per artifact
```

Per shape, with `maxRounds = 3`:

| shape       | calls / round | worst-case calls | est. cost | vs. default |
|-------------|---------------|-------------------|-----------|-------------|
| compact     | 3             | 9                 | ~$0.09    | -75 %       |
| cross-model | 12            | 36                | ~$0.36    | baseline    |
| full (1 ex) | 16            | 48                | ~$0.48    | +33 %       |

Pair `compact` with `maxRounds: 1` for the cheapest sane configuration
(3 calls / artifact, no retries). Recipes that already self-heal can do
this without measurable quality regression on the kb-grounding fixture
(see `packages/judge-panel/test/auto-improve.test.ts`).

## Picking a shape per recipe

A rule of thumb, mapped onto current recipes:

| recipe                            | suggested shape | maxRounds |
|-----------------------------------|-----------------|-----------|
| `copilot-studio-support-bot`      | compact         | 2         |
| `copilot-studio-field-service`    | cross-model     | 3         |
| `copilot-studio-custom`           | cross-model     | 3         |
| `teams-bot-basic`                 | compact         | 2         |
| `teams-tab-basic`                 | compact         | 1         |
| `teams-message-extension`         | compact         | 2         |
| `teams-agent-365`                 | full            | 5         |

Override by setting `judge.shape` and `judge.maxRounds` in the
`FactoryContext` passed to `runCopilotStudio` / `runTeamsApp`.

## Voting policy stays the same

`policy.vetoOn`, `policy.quorum`, and `policy.tieBreaker` (see
[judge-panel.md](./judge-panel.md)) all behave identically across the three
shapes. `compact` produces one `Verdict` per persona-per-model bundle, so
the security veto still fires the moment any model rejects the security
brief — even if the other personas in the same bundle approved.
