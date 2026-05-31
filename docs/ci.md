# CI / CD

App Factory ships with two GitHub Actions workflows. All actions are first-party
(`actions/*`, `github/*`) plus `pnpm/action-setup` — no third-party actions.

## Workflows

### `.github/workflows/ci.yml`

Trigger: every push to `main` and every pull request targeting `main`.

Runs on `ubuntu-latest` with a Node matrix of `22` and `24`. Steps:

1. `actions/checkout@v4`
2. `pnpm/action-setup@v4` — pnpm version is taken from the `packageManager`
   field in root `package.json` (`pnpm@11.1.3`).
3. `actions/setup-node@v4` with `cache: pnpm`.
4. `pnpm install --frozen-lockfile`
5. `pnpm typecheck` — root script delegates to `turbo run typecheck`, which
   honors `^build` so each package's tsc sees built siblings.
6. `pnpm build` — `turbo run build`.
7. `pnpm -r test` — vitest across every workspace package.
8. `pnpm lint` — `biome check .` (read-only; CI will fail rather than auto-fix).
9. `actions/upload-artifact@v4` uploads `packages/*/dist` and
   `packages/skill-adapters/*/dist` from the Node 22 leg of the matrix.

Concurrency is grouped per ref; PR runs cancel previous attempts, pushes to
`main` do not.

### `.github/workflows/release.yml`

Trigger: pushed tags matching `v*`.

Two jobs:

- **`ci-gate`** — repeats the install/typecheck/build/test/lint sequence on
  Node 22 to guarantee the tag is green before a release artifact is published.
- **`release`** — depends on `ci-gate`. It:
  1. Builds `@app-factory/cli` (with workspace deps) and packs it with
     `pnpm pack`.
  2. Builds the skill adapters and invokes their installers against a
     throw-away `HOME` to materialize `SKILL.md` and the `gh-app-factory`
     script directly from the source-of-truth modules.
  3. Tars everything into `release/app-factory-<tag>.tar.gz`.
  4. Generates a changelog of commits between the previous tag and the new
     tag (`git log --pretty=format:'- %s (%h)'`).
  5. Publishes a GitHub Release via `gh release create` with the tarball
     attached and the changelog as release notes.

## Local parity

Run the same gate locally before pushing a tag:

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm -r test
pnpm lint
```

## Dependabot

`.github/dependabot.yml` opens weekly Monday PRs for npm and GitHub Actions.
The npm ecosystem groups updates by family — one PR for `@azure/*` /
`azure-*`, one PR for `@microsoft/*` / `microsoft-*` — and ignores
`@app-factory/*` (workspace-internal packages).

## CODEOWNERS

`.github/CODEOWNERS` assigns `@lp-roux` as the default reviewer for every
path in the repo.
