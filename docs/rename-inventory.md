# Rename inventory — AgentLens → TBD

> Prepared BEFORE the first npm publish. No renames have been applied yet.
> One clean rename is cheaper than a breaking change after v0.1.0.

Scope conflict: `AgentLens` is already used by other developer tools and the
npm `@agentlens` scope is taken. The current packages are unpublishable under
that scope without a conflict.

This document lists every occurrence of the five identifiers and classifies
how painful it would be to rename each one.

## Identifiers inventoried

| Token | Hits (non-vendored) |
|---|---|
| `AgentLens` | ~22 |
| `agentlens` | ~58 |
| `@agentlens/core` | ~20 |
| `agentlensVersion` | 1 (+ 2 docs/JSON examples) |
| `AGENTLENS_HOME` | ~8 |

Counts exclude `node_modules`, `.git`, and `dist`. Fixtures under `fixtures/`
and the synthetic prefix `agentlens-bench-`/`agentlens-edge-` are counted
separately where noted.

## Full inventory by category

### 1. Product branding (title, description, prose)

| File:line | Text | Note |
|---|---|---|
| `README.md:1` | `# AgentLens` | H1 |
| `packages/core/package.json:4` | `Core scanner library for AgentLens` | npm description |
| `packages/cli/package.json:4` | `AgentLens CLI` | npm description |
| `packages/cli/src/index.ts:2,29` | `AgentLens CLI …`, `AgentLens — DevTools…` | help banner + comment |
| `packages/cli/src/index.ts:149,156,174` | `AgentLens could not run…`, banner | user-facing strings |
| `docs/*.md` | ~6 titles/first-lines | architecture, limitations, etc. |
| `LICENSE:3` | `AgentLens contributors` | copyright line |
| `benchmarks/bench.mjs:26` | `agentlens-bench-` temp prefix | internal |
| `tests/edge.test.ts:9,12`, `tests/helpers.ts:32` | `agentlens-*` temp prefixes | tests only |

### 2. npm package identifiers (publish-time breaking if changed after publish)

| File:line | Text |
|---|---|
| `package.json:3,11,12` | `agentlens-monorepo`, `--workspace @agentlens/core`, `--workspace agentlens` |
| `package-lock.json:2,8,17,31,57,61,64,75` | lockfile entries for both packages |
| `packages/core/package.json:2` | `"name": "@agentlens/core"` |
| `packages/cli/package.json:2,44` | `"name": "agentlens"`, dep `"@agentlens/core": "^0.1.0"` |
| `packages/core/README.md:1,6`, `packages/cli/README.md:1` | README install snippets |

### 3. CLI binary

| File:line | Text |
|---|---|
| `packages/cli/package.json:29` | `"bin": { "agentlens": "./dist/index.js" }` |
| `package.json:14-15` | `scan`, `benchmark` scripts via `agentlens` binary path |
| `README.md:6,56,60` | `npx agentlens` examples |
| `docs/architecture.md:26` | `cli/  agentlens — argument parsing…` |

### 4. Public API / JSON schema field

| File:line | Text | Schema impact |
|---|---|---|
| `packages/cli/src/index.ts:129` | `agentlensVersion: cliVersion()` | emitted in every `--json` envelope |
| `README.md:121` | `"agentlensVersion": "0.1.0"` | documented example |
| `tests/cli.test.ts:45` | `assert.match(j.agentlensVersion…)` | contract test |

If published, renaming this key is a **breaking schema change** (`schemaVersion`
would need to bump).

### 5. Environment variable

| File:line | Text |
|---|---|
| `packages/cli/src/index.ts:59,484` | `process.env.AGENTLENS_HOME` |
| `packages/core/src/fs.ts:7`, `types.ts:130` | `process.env.AGENTLENS_HOME`, doc comment |
| `docs/architecture.md:27,48`, `docs/creating-an-adapter.md:47,88` | `AGENTLENS_HOME` in docs |
| `tests/*.test.ts`, `.github/workflows/ci.yml:47,48` | test + CI usage |

Changing the env var after publish is **breaking for CI and power users**.

### 6. Documentation / comments

| File:line | Text |
|---|---|
| `docs/adapters.md`, `docs/architecture.md`, `docs/limitations.md`, `docs/creating-an-adapter.md` | `AgentLens`, `@agentlens/core`, `AGENTLENS_HOME` in prose |
| `packages/core/src/types.ts:2`, `packages/core/src/index.ts:1` | `Shared types for @agentlens/core`, `Public API of @agentlens/core` |

### 7. Fixture / test artefacts (not shipped)

| File:line | Text |
|---|---|
| `fixtures/**` | none of the fixture `AGENTS.md`/`CLAUDE.md` mention `agentlens` |
| `tests/fixtures` paths | `fx("home")` uses `fixtures/home` (shares the GitHub repo name) |

### 8. GitHub repository

| Location | Text |
|---|---|
| `packages/*/package.json:20,23,25` | `https://github.com/amaansyed27/agentlens` (+ issues/homepage) |
| Remote | `origin` → `github.com/amaansyed27/agentlens.git` |
| GitHub | Repo name `amaansyed27/agentlens` (public) |

Renaming the GitHub repo after publish breaks `repository.url`/`homepage` and
any existing clones (GitHub redirects, but npm `repository` would be stale).

## Safe to rename BEFORE v0.1.0 vs. commitment AFTER publish

### Safe before first publish (one mechanical `s/agentlens/NEW/g` + repo rename)

- All of §1 product branding, docs titles, LICENSE copyright, `benchmarks/` and
  test temp prefixes — no downstream contract.
- Fixture/test strings (no shipped code).
- Internal comments (`packages/cli/src/index.ts:2`, `packages/core/src/types.ts:2`).

### Becomes a compatibility commitment once published to npm

| Identifier | Why it locks |
|---|---|
| `agentlens` (CLI package + `bin`) | `npx agentlens` and `npm install -g agentlens`; rename requires a *new* package, old name abandoned or deprecated |
| `@agentlens/core` | every `import from "@agentlens/core"` in consumer code; scope rename is a semver major |
| `agentlensVersion` in JSON envelope | external tools switch on the envelope; renaming the key breaks `schemaVersion: 1` consumers, needs schema bump + deprecation |
| `AGENTLENS_HOME` | CI env and user shell configs; rename needs alias/shim or major |
| `repository` / `homepage` / GitHub repo name | `package.json` metadata + git remotes; old URLs redirect but npm provenance and badges break |

## Recommended rename procedure (when a new name is chosen)

1. Pick `NEW` (kebab-case binary, e.g. `newname`) and `NEW_CAMEL` (`NewName`)
   and `@scope/newname` (ideally `@newname/core` or `@newscope/core` if the
   top-level name is taken).
2. Mechanical replace across `package.json`, `packages/*/package.json`,
   `README.md`, `docs/*.md`, `packages/cli/src/index.ts` help strings,
   `agentlensVersion` key, `AGENTLENS_HOME` constant + docs + `ci.yml`,
   benchmark/test prefixes, and `LICENSE`.
3. `gh repo rename` (or create new repo + mirror), update `repository.url`.
4. `npm pack --dry-run` for both packages: verify no `agentlens` or old scope leaks.
5. `git clean -xfd && npm ci && npm run build && npm run lint && npm test` on
   Node 20/22/24, plus tarball-install smoke test.
6. Publish as **first** public version; do not publish the old name even as
   `0.0.1` — it claims the name and forces a deprecation story.

## Appendix — raw hit list

Generated from `git grep` excluding `node_modules/.git/dist` (116 hits).
Full line list is in the CI build artifact `inventory.txt` dumped during this pass.
