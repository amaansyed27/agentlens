/** Public API of instrace-core. */
export type {
  AgentScan,
  ConflictFinding,
  ContextSource,
  DiffReport,
  DuplicateFinding,
  EffectiveContext,
  ExplainReport,
  ScanReport,
  SourceKind,
  TokenBreakdown,
} from "./types.js";
export { estimateTokens, describeText, estimateMcpTokens } from "./tokenizer.js";
export { findDuplicates, normalizeLine } from "./similarity.js";
export { findConflicts } from "./conflicts.js";
export { scanProject, resolveAgent, explainPath, compareAgents } from "./scanner.js";
export type { ExplainOptions, CompareAgentsOptions } from "./scanner.js";
export type { AgentAdapter, AdapterContext } from "./adapters/adapter.js";
export { registerAdapter, getAdapter, listAdapters } from "./adapters/registry.js";
export { opencodeAdapter } from "./adapters/opencode.js";
export { codexAdapter } from "./adapters/codex.js";
export { claudeAdapter, extractImports } from "./adapters/claude.js";
