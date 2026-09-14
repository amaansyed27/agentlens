# Instrace

**Trace what instructions your coding agent actually sees.**

Instrace is a local developer tool for inspecting the effective context loaded by AI coding agents such as OpenCode, Codex, and Claude Code.

```bash
npx instrace
```

No cloud backend. No account. No API key. No LLM required.

## Why

Coding agents silently load project instructions, global rules, `AGENTS.md` / `CLAUDE.md`, skills, agent definitions, and MCP configuration before you send a prompt. Different agents resolve that context differently.

Instrace reconstructs that context locally so you can answer:

- What context is my agent actually receiving?
- Which files are loaded or skipped, and why?
- Which instructions override others?
- Where are rules duplicated or contradictory?
- How much context is being consumed?
- Why do two coding agents behave differently in the same repository?

## Quick start

```bash
npx instrace scan
```

Or install it globally:

```bash
npm install -g instrace
instrace scan
```

Requires Node.js 20+.

## Commands

| Command | Purpose |
|---|---|
| `instrace scan` | Detect agents, context sources, estimated tokens, and warnings |
| `instrace tree [--agent id]` | Show where loaded context comes from |
| `instrace tokens [--max n]` | Break down context cost and optionally enforce a budget |
| `instrace conflicts` | Find deterministic instruction contradictions |
| `instrace duplicates` | Find duplicated instruction blocks and estimated savings |
| `instrace explain <path>` | Explain exactly why context applies to a file |
| `instrace diff <a> <b>` | Compare what two coding agents load in the same repo |

Every command supports `--json`, `--cwd`, `--agent`, and `--no-color`.

```bash
instrace scan --json
instrace tokens --max 20000
instrace explain src/auth/login.ts --agent claude
instrace diff opencode codex
```

## `explain` is the core feature

```bash
instrace explain src/auth/login.ts --agent claude
```

For a target file, Instrace shows the instruction sources that apply and why they apply — global, project, nearest scoped file, applicable skill, or on-demand nested context — plus sources that were skipped and the reason they were skipped.

## Supported agents

| Agent | Resolved context |
|---|---|
| OpenCode | Global + upward `AGENTS.md` chain, `.opencode/AGENTS.md`, `opencode.json` instructions, agents, skills, MCP |
| Codex | Global override chain, root → cwd `AGENTS.md` chain, per-directory overrides, 32 KiB budget |
| Claude Code | User/project/local `CLAUDE.md`, `@imports`, `.claude/rules` path scoping, subagents, skills, MCP |

## Example output

```text
Instrace

Detected agents
  ✓ OpenCode
  ✓ Codex

Estimated context
  Instructions       83 tokens
  Skills             22 tokens
  Tool definitions   2,140 tokens
  Other              33 tokens

  Total               2,278 tokens

Warnings
  ⚠ Package manager differs between instruction files
```

## JSON output

Every command supports `--json`. Stdout contains one stable JSON document while diagnostics stay on stderr.

```json
{
  "schemaVersion": 1,
  "instraceVersion": "0.1.1",
  "command": "scan",
  "data": {}
}
```

Exit codes:

```text
0  successful analysis
1  usage error or analysis failure
2  policy/budget threshold exceeded
```

## Notes on accuracy

Instrace deterministically resolves supported instruction-loading rules. Token counts are estimates using a local heuristic, and MCP tool schema costs are estimated without connecting to servers. Uncertain information is marked rather than invented.

## Library

The scanner engine is also available as [`instrace-core`](https://www.npmjs.com/package/instrace-core).

```bash
npm install instrace-core
```

## Links

- GitHub: https://github.com/amaansyed27/instrace
- Documentation: https://github.com/amaansyed27/instrace#readme
- Adapter details: https://github.com/amaansyed27/instrace/blob/main/docs/adapters.md
- Limitations: https://github.com/amaansyed27/instrace/blob/main/docs/limitations.md
- Issues: https://github.com/amaansyed27/instrace/issues

## License

MIT
