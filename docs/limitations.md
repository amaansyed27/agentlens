# Limitations

AgentLens reconstructs context from files and documented resolution rules. It
does not (and cannot) observe everything:

- **Token counts are estimates.** The local heuristic (~4 chars/token) is for
  budgeting and comparison, not billing. Real usage varies by model and
  tokenizer. Large non-text or non-English content skews the estimate.
- **MCP schemas are estimated.** Tool definitions are counted without
  connecting to servers, so MCP token figures are marked `[unverified]`.
  Connect-time schema fetching is a possible future feature, not V0.
- **Conflict detection is syntactic.** Ten rule families (package manager,
  indentation, semicolons, quotes, test/build commands, language, formatter,
  edit restrictions, framework) are matched with conservative regexes. Each
  finding carries a severity and a confidence level; anything subtler than
  the patterns is out of scope by design.
- **Duplicate detection is textual.** Sliding-window Jaccard similarity (≥
  0.8) finds copied blocks, not paraphrases. No embeddings, no network — this
  is intentional for a local-first tool.
- **Agent behaviour drifts.** Resolution rules are verified against the docs
  linked in `docs/adapters.md` (checked 2026-09). Where V1/V2 docs disagree
  (OpenCode `CLAUDE.md` fallback) or docs are silent (skill surfacing, MCP
  payload shape), output is marked `[unverified]` instead of guessed.
- **Scope platforms.** Paths are handled with Node's `path` module
  (Windows/Linux/macOS tested via unit tests for separators and `~`
  expansion). Symlinked repos are followed with cycle protection; exotic
  setups (remote filesystems, case-insensitive collisions) get best-effort
  handling.
- **No live session data.** AgentLens shows what an agent *should* load from
  configuration, not what a running session actually holds (compaction,
  session memory, and MCP runtime state are invisible from disk).
