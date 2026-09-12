# Agent resolution models

Each adapter implements its agent's context resolution individually and cites
the documentation it was verified against. Entries the CLI marks
`[unverified]` are inferred (e.g. estimated MCP schemas) rather than
confirmed.

## OpenCode

Refs:

- <https://opencode.ai/docs/rules/>
- <https://opencode.ai/v2/docs/instructions/>

Model implemented in `packages/core/src/adapters/opencode.ts`:

1. **Global** `~/.config/opencode/AGENTS.md` (`$XDG_CONFIG_HOME` when set).
2. **Upward chain**: every `AGENTS.md` from the working location up to the
   project root (or home). Rendered global-first, then location → root.
3. **V1 fallback**: `CLAUDE.md` at a level is used only when no `AGENTS.md`
   exists there — marked `unverified` because V2 docs state only `AGENTS.md`
   is recognised.
4. **`.opencode/AGENTS.md`** companion files — `unverified`.
5. **`instructions` arrays** in `opencode.json(c)`: closest config wins,
   arrays are not merged (per V2 docs). Glob entries are expanded with a
   minimal single-star matcher; `http(s)` entries are reported as
   unresolvable in V2 (`unverified`).
6. **Agents** (`.opencode/agents/*.md`): conditional, load on invocation.
7. **Skills**: descriptions surfaced, bodies on demand — conditional
   (`unverified`: exact surfacing varies by version).
8. **MCP** (`mcp` / `mcpServers` keys): tool schemas estimated without
   connecting (`unverified`).
9. **Nested `AGENTS.md` below the working location**: dynamic — loads once
   per session when the read tool touches that subtree (per V2 docs).

## Codex

Refs:

- <https://developers.openai.com/codex/guides/agents-md>
- `codex-rs/core/src/agents_md.rs` (upstream source)

Model implemented in `packages/core/src/adapters/codex.ts`:

1. **Global**: `$CODEX_HOME/AGENTS.override.md`, else `$CODEX_HOME/AGENTS.md`
   (first non-empty; `CODEX_HOME` defaults to `~/.codex`).
2. **Project**: git root → cwd, at most one file per directory:
   `AGENTS.override.md` > `AGENTS.md` > `project_doc_fallback_filenames`
   (parsed from `~/.codex/config.toml`).
3. **Merge**: root-down concatenation; deeper files appear later and win.
4. **Budget**: `project_doc_max_bytes` (default 32 KiB) truncates the tail;
   truncated sources are demoted with an explicit reason plus a warning.
5. **Skills / MCP**: `.codex/skills` and `[mcp_servers]` entries —
   conditional / estimated (`unverified` where Codex docs are silent).

## Claude Code

Ref:

- <https://code.claude.com/docs/en/memory>

Model implemented in `packages/core/src/adapters/claude.ts`:

1. **Scopes**: user `~/.claude/CLAUDE.md`, project `./CLAUDE.md` (and
   `./.claude/CLAUDE.md`), local `CLAUDE.local.md` after `CLAUDE.md` at the
   same level. (Managed-policy paths are environment-specific and listed as
   absent rather than guessed.)
2. **Upward walk** from cwd, root-down concatenation; nearer files win.
3. **Subdirectory files** below cwd are lazy: reported as dynamic with the
   subtree scope that triggers them.
4. **`@path` imports**: resolved relative to the importing file, code fences
   ignored, max 4 hops, still launch context. Missing targets are reported.
5. **Rules** (`.claude/rules/*.md`, recursive): files with a `paths`
   frontmatter are conditional; others always load. `claudeMdExcludes` from
   project/user `settings.json` is honoured.
6. **Subagents / skills**: dynamic / on demand.
7. **`AGENTS.md` is not native** — surfaced as not-loaded with the fix
   (`@AGENTS.md` import), unless already imported.
8. **MCP** from `.claude.json` / `settings.json` `mcpServers`: estimated
   (`unverified`).

## Updating behaviour

Agent behaviour drifts. When docs change, update the adapter, its `docRefs`,
and the corresponding fixture + integration test. Never silently widen an
`unverified` behaviour into a certain one.
