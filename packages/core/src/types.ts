/**
 * Shared types for @agentlens/core.
 *
 * All cross-boundary results are plain JSON-serialisable structures so the
 * CLI `--json` output and the programmatic API share one stable shape.
 */

/** Where a piece of context comes from. */
export type SourceKind =
  | "global"
  | "project"
  | "directory"
  | "skill"
  | "agent"
  | "mcp"
  | "dynamic"
  | "instruction";

/** A single file, config entry, or generated block an agent may load. */
export interface ContextSource {
  /** Stable id, e.g. `opencode:agents-md:/abs/path`. */
  id: string;
  /** Which adapter discovered it. */
  agentId: string;
  kind: SourceKind;
  /** Short human label, e.g. `AGENTS.md` or `skill:frontend`. */
  label: string;
  /** Absolute path when backed by a file. */
  path?: string;
  /** File exists on disk (false for referenced-but-missing entries). */
  exists: boolean;
  /** Loaded on every request vs conditionally / on-demand. */
  alwaysLoaded: boolean;
  /** Estimated tokens (local heuristic, see tokenizer.ts). */
  tokens: number;
  chars: number;
  lines: number;
  /** Directory this source scopes to (for directory-scoped instructions). */
  scope?: string;
  /** Why the agent loads (or skips) this source. */
  reason: string;
  /** True when the behaviour is inferred, not verified against docs. */
  unverified?: boolean;
  /** Extra detail, e.g. MCP server name or truncation note. */
  detail?: string;
  /** 1-based line range for duplicate/conflict excerpts. */
  lineRange?: { start: number; end: number };
}

/** Token breakdown shown by `scan` and `tokens`. */
export interface TokenBreakdown {
  instructions: number;
  skills: number;
  tools: number;
  other: number;
  alwaysLoaded: number;
  conditional: number;
  total: number;
}

/** Result of resolving which sources apply for one agent in one directory. */
export interface EffectiveContext {
  agentId: string;
  cwd: string;
  loaded: ContextSource[];
  notLoaded: ContextSource[];
  breakdown: TokenBreakdown;
  warnings: string[];
}

/** One agent's full scan result. */
export interface AgentScan extends EffectiveContext {
  detected: boolean;
}

/** Top-level `scanProject` result (stable JSON shape). */
export interface ScanReport {
  version: 1;
  cwd: string;
  agents: AgentScan[];
  duplicates: DuplicateFinding[];
  conflicts: ConflictFinding[];
  generatedAt: string;
}

/** A duplicated / highly-similar instruction block. */
export interface DuplicateFinding {
  a: { path: string; start: number; end: number };
  b: { path: string; start: number; end: number };
  similarity: number;
  tokensWasted: number;
  excerpt: string;
}

/** A detected instruction conflict. */
export interface ConflictFinding {
  rule: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  /** HIGH = explicit contradiction, MEDIUM/LOW = likely but not certain. */
  confidence: "HIGH" | "MEDIUM" | "LOW";
  sources: { path: string; value: string; line?: number }[];
  message: string;
}

/** `explainPath` result: why TARGET sees each instruction. */
export interface ExplainReport {
  version: 1;
  agentId: string;
  cwd: string;
  target: string;
  loaded: { path: string; reason: string; tokens: number }[];
  notLoaded: { path: string; reason: string }[];
}

/** `compareAgents` result. */
export interface DiffReport {
  version: 1;
  cwd: string;
  left: string;
  right: string;
  rows: { label: string; left: boolean; right: boolean }[];
  tokens: { left: number; right: number };
  differences: { severity: "HIGH" | "MEDIUM" | "LOW"; message: string }[];
}

export interface ScanOptions {
  cwd?: string;
  /** Restrict to one agent (`opencode` | `codex` | `claude`). */
  agent?: string;
  /** Override home dir (tests / portable use). Honors AGENTLENS_HOME env. */
  homeDir?: string;
}
