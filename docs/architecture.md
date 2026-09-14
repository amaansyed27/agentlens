# Architecture

Instrace is a monorepo with two publishable packages and a strict dependency
rule: **core depends on nothing** (Node.js builtins only). The CLI depends
only on core. Tests run on the Node.js built-in test runner. The only
devDependencies are `typescript` and `@types/node`.

```
instrace/
  packages/
    core/          instrace-core — scanner library
      src/
        types.ts        JSON-stable result shapes (ScanReport v1, …)
        tokenizer.ts    local ~4 chars/token estimate
        fs.ts           symlink-aware, cross-platform file helpers
        similarity.ts   sliding-window Jaccard duplicate detection
        conflicts.ts    pattern-based contradiction detection
        scanner.ts      scanProject / resolveAgent / explainPath / compareAgents
        adapters/
          adapter.ts    AgentAdapter interface
          helpers.ts    fileSource / JSONC / glob helpers
          opencode.ts   OpenCode discovery + resolution
          codex.ts      Codex discovery + resolution
          claude.ts     Claude Code discovery + resolution
          registry.ts   registerAdapter / getAdapter / listAdapters
    cli/             instrace — argument parsing + terminal rendering only
  fixtures/          per-agent repos + shared fake $HOME (INSTRACE_HOME)
  tests/             node:test suites run against built dist/
  docs/              adapters.md, architecture.md, limitations.md
```

## Design decisions

- **Adapters own agent behaviour.** Core orchestration (`scanner.ts`) never
  branches on agent ids. Adding Cursor means adding one file + one registry
  line.
- **`discover` vs `resolve`.** `discover` lists every candidate source
  (including missing files and dynamic entries); `resolve` partitions them
  into `loaded` / `notLoaded` and computes the token breakdown. `explain` and
  `diff` reuse the same structures, so CLI output and `--json` can't diverge.
- **Missing files are data, not errors.** A referenced-but-absent file is a
  `ContextSource` with `exists: false` and a reason — this is what lets
  `explain` say *why* something is not loaded.
- **Warnings, not crashes.** Malformed `opencode.json` / `config.toml` /
  `settings.json` produce warnings naming the file. Scans never throw on
  user config.
- **Testability.** Home-directory access goes through `effectiveHomeDir()`,
  which honours `INSTRACE_HOME`, so integration tests run against
  `fixtures/home` without touching the real `$HOME`.
- **Determinism.** Duplicate and conflict detection are pure functions of
  file text. Same repo, same output, every run.
