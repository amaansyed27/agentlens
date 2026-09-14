# instrace-core

Dependency-free scanner library behind [Instrace](https://github.com/amaansyed27/instrace).

Use it when you want to inspect, explain, or compare the context that coding agents load without shelling out to the CLI.

```bash
npm install instrace-core
```

Requires Node.js 20+.

## Quick start

```ts
import {
  scanProject,
  explainPath,
  compareAgents,
} from "instrace-core";

const report = await scanProject({
  cwd: process.cwd(),
  agent: "opencode",
});

const why = await explainPath({
  cwd: process.cwd(),
  agent: "claude",
  target: "src/auth/login.ts",
});

const diff = await compareAgents({
  cwd: process.cwd(),
  left: "opencode",
  right: "codex",
});
```

## What it does

- Resolves effective coding-agent instruction context
- Explains why context applies to a specific path
- Compares effective context across supported agents
- Detects duplicated instruction blocks
- Detects deterministic instruction conflicts
- Estimates context/token usage locally
- Supports custom adapters through `registerAdapter`

## Supported agents

- OpenCode
- Codex
- Claude Code

The loading rules and known limitations are documented in the main repository:

- https://github.com/amaansyed27/instrace/blob/main/docs/adapters.md
- https://github.com/amaansyed27/instrace/blob/main/docs/limitations.md
- https://github.com/amaansyed27/instrace/blob/main/docs/creating-an-adapter.md

## Properties

- Zero runtime dependencies
- ESM
- TypeScript declarations included
- No network access required
- No API key
- No LLM required

## Accuracy

Instruction resolution is deterministic for the supported adapter behavior. Token counts are estimates using a local heuristic, and live runtime state such as conversation compaction or dynamically exposed MCP schemas cannot be reconstructed from files alone.

## CLI

For the ready-to-run developer tool:

```bash
npx instrace
```

npm: https://www.npmjs.com/package/instrace

## License

MIT
