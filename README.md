# Instrace

**Trace what instructions your coding agent actually sees.**

```bash
npx instrace
```

```
Instrace

Detected agents
  ✓ OpenCode
  ✓ Codex

Context sources
  opencode
   AGENTS.md
   docs/standards.md
   mcp:github  [unverified]
  codex
   AGENTS.md

Estimated context
  Instructions       83 tokens
  Skills             22 tokens
  Tool definitions   2,140 tokens
  Other              33 tokens

  Total               2,278 tokens

Warnings
  ⚠ Package manager differs between instruction files
```

## The problem

OpenCode, Codex, Claude Code and friends each load a different mix of project
instructions, global instructions, `AGENTS.md` / `CLAUDE.md` files, skills,
agent definitions and MCP tool configs — before you even send a prompt. When
an agent misbehaves, you can't see what it was actually told.

Instrace reconstructs that context **locally** and answers:

- What is my agent actually receiving, and how many tokens does it cost?
- Which files are loaded, which are skipped — and **why**?
- Which instructions override others?
- What is duplicated, and what contradicts?
- Why do Codex and OpenCode behave differently in the same repository?

No cloud backend. No account. No API key. No LLM required.

## Installation

```bash
npx instrace scan
```

```bash
npm install -g instrace        # CLI
npm install instrace-core     # library
```

Requires Node.js 20+.

## Commands

| Command | What it shows |
|---|---|
| `instrace scan` | Detected agents, sources, token totals, warnings |
| `instrace tree [--agent id]` | Where every piece of context comes from — global, project, directory, skill, agent, MCP, dynamic |
| `instrace tokens [--max n]` | Always-loaded vs on-demand vs tool schemas, largest sources; exits `2` when total exceeds `--max` (CI budgets) |
| `instrace conflicts` | Deterministic instruction contradictions, with severity and confidence |
| `instrace duplicates` | Duplicated instruction blocks with line ranges and per-request token savings |
| `instrace explain <path>` | Why the agent sees each instruction for that file |
| `instrace diff <a> <b>` | Why two agents behave differently in the same repo |

Every command supports `--json`, `--cwd`, `--agent` and `--no-color`.

```bash
instrace scan --json
instrace tokens --max 20000
instrace explain src/auth/login.ts --agent claude
instrace diff opencode codex
```

`explain` is the heart of the tool. For any file it lists each loaded
instruction with the reason it applies (global, project, nearest scoped
file, applicable skill, on-demand nested file) and each skipped source with
the reason it doesn't (outside path scope, conditional, missing, natively
unreadable).

## Supported agents

| Agent | What Instrace resolves |
|---|---|
| OpenCode | Global + upward `AGENTS.md` chain, `.opencode/AGENTS.md`, `opencode.json` `instructions`, agents, skills, MCP |
| Codex | Global override chain, root → cwd `AGENTS.md` chain with per-directory override files and the 32 KiB budget |
| Claude Code | User/project/local `CLAUDE.md`, `@imports` (4 hops), `.claude/rules` with path scoping, subagents, skills, MCP |

New agents plug in through one interface without touching the core — see
[docs/creating-an-adapter.md](docs/creating-an-adapter.md).

## Programmatic API

```ts
import { scanProject, explainPath, compareAgents } from "instrace-core";

const report = await scanProject({ cwd: process.cwd(), agent: "opencode" });
const why = await explainPath({ cwd: process.cwd(), agent: "opencode", target: "src/auth/login.ts" });
const diff = await compareAgents({ cwd: process.cwd(), left: "opencode", right: "codex" });
```

## JSON output and exit codes

Every command accepts `--json`. Stdout then carries exactly one document:

```json
{
  "schemaVersion": 1,
  "instraceVersion": "0.1.0",
  "command": "scan",
  "data": { "version": 1, "cwd": "...", "agents": ["..."] }
}
```

Diagnostics and errors always go to stderr, so parsers never break. External
tools should switch on `schemaVersion` (currently `1`); it only increments on
breaking envelope changes.

Exit codes:

```text
0  successful analysis
1  usage error or analysis failure (bad path, unknown agent, …)
2  policy/budget threshold exceeded (tokens --max)
```

## What Instrace can know reliably

- Which instruction, skill, agent and MCP-config files exist, and their sizes
- How each supported agent resolves those files (verified against the docs
  linked in [docs/adapters.md](docs/adapters.md))
- Textual duplication between instructions (local similarity, no embeddings)
- Explicit contradictions matched by conservative patterns

## What Instrace estimates

- **Token counts** use a local ~4 chars/token heuristic — good for budgeting
  and comparing agents, not for billing. Real usage varies by model.
- **MCP tool schemas** are counted without connecting to servers.

Both are marked `[unverified]` in terminal output wherever they appear.

## What Instrace cannot know

- Live session state: compaction, conversation memory, runtime MCP schemas.
- Paraphrased (non-textual) duplication or subtle semantic conflicts — the
  detectors report confidence levels and stay silent rather than guess.
- Agent behaviour that changed after the docs were last verified; uncertain
  entries are marked `[unverified]` instead of invented.

Details in [docs/limitations.md](docs/limitations.md).

## Architecture

```
packages/core   dependency-free scanner library (instrace-core)
packages/cli    argument parsing + terminal rendering (instrace)
fixtures/       per-agent repos used by integration tests
tests/          unit + adapter + edge-case + CLI smoke tests
benchmarks/     repeatable synthetic-repo benchmark (npm run benchmark)
docs/           adapters, architecture, limitations, adapter guide
```

See [docs/architecture.md](docs/architecture.md).

## Development

```bash
npm install
npm run build
npm run lint
npm test
npm run benchmark
```

## Roadmap

- Cursor / Aider adapters (same `AgentAdapter` interface)
- `--fix` suggestions for deduplication
- Watch mode

## License

MIT
