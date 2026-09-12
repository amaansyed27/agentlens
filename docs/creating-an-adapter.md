# Creating an adapter

AgentLens learns a new coding agent through one file plus one registry line.
Core orchestration (`scanProject`, `explainPath`, `compareAgents`) never
branches on agent ids, so you don't need to understand the whole codebase.

## 1. Copy a neighbour

Start from the closest existing adapter in
`packages/core/src/adapters/`:

- file-based instructions with precedence chains → `codex.ts`
- imports / scopes / lazy loading → `claude.ts`
- JSON config with extra instruction entries → `opencode.ts`

Shared helpers live in `helpers.ts` (`fileSource`, `missingSource`,
`parseJsonc`, `expandSimpleGlob`).

## 2. Implement the interface

```ts
import { registerAdapter, type AgentAdapter } from "@agentlens/core";

export const myAdapter: AgentAdapter = {
  id: "my-agent",               // stable, lowercase, used by --agent
  label: "My Agent",            // display name
  docRefs: ["https://example.com/docs/instructions"],

  // True when this agent plausibly applies to ctx.cwd
  // (project markers, config files, or global config present).
  detect: async (ctx) => ...,

  // List every candidate source: existing files, referenced-but-missing
  // files, and dynamic entries. Never throw on user config — report
  // malformed files via (out as any).__warnings.
  discover: async (ctx) => ...,

  // Partition into loaded / notLoaded, root-first ordering, token
  // breakdown. Reuse the breakdown shape from the existing adapters.
  resolve: async (ctx, sources) => ...,
};

registerAdapter(myAdapter);
```

`ctx` gives you `{ cwd, homeDir, projectRoot }`. `homeDir` already honours
`AGENTLENS_HOME`, so tests can fake a home directory. `projectRoot` is the
git root or `null`.

## 3. Source kinds and confidence

Pick the honest `kind` for each `ContextSource`:

- `global` / `project` / `directory` — instruction files with a scope
- `skill`, `agent`, `mcp` — loaded conditionally or estimated
- `dynamic` — loads on demand later (nested files, lazy rules)
- `instruction` — explicit config entries (`@imports`, `instructions` arrays)

Rules for trust:

- `alwaysLoaded: false` for anything conditional; it lands in `notLoaded`
  with your `reason` explaining when it *would* load.
- `unverified: true` for anything inferred rather than confirmed against
  docs (estimated schemas, version-dependent surfacing). The CLI renders
  `[unverified]` automatically.
- `exists: false` with a `reason` for referenced-but-missing files — this is
  what lets `explain` say *why* something is not loaded.
- Record `docRefs`: the exact documentation URLs you verified against, so a
  future maintainer can re-check when the agent's behaviour drifts.

## 4. Fixtures and tests

Add a realistic fixture repo under `fixtures/<id>/...` (basic, nested,
conflicts — see the existing ones) for manual testing, and hermetic
integration tests in `tests/adapters.test.ts`. Build test repos in temp dirs
with their own `.git/HEAD` (see `tests/helpers.ts` `mkRepo`) so results never
depend on whether the checkout itself sits inside a git repository:

```ts
const dir = await mkRepo({
  "AGENTS.md": "Always use pnpm.\n",
  ".opencode/agents/build.md": "Run tests first.\n",
});
const ec = await resolveAgent(dir, "<id>", HOME);
assert.ok(ec.loaded.some((s) => s.kind === "project"));
```

Set `process.env.AGENTLENS_HOME` to `fixtures/home` (or a temp dir) so tests
never touch the real home. Run `npm test` — build, lint and all suites must
pass on Windows, macOS and Linux.

## 5. Register and document

- Add the adapter to `packages/core/src/adapters/registry.ts`.
- Document its resolution model in `docs/adapters.md` with verification
  date and doc links.
- Add a row to the README's supported-agents table.

That's it — `scan`, `tree`, `tokens`, `conflicts`, `duplicates`, `explain`,
`diff` and `--json` pick the new agent up with no further changes.
