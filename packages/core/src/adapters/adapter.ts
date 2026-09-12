/** Pluggable agent adapter contract. Core never hardcodes agent behaviour. */
import type { ContextSource, EffectiveContext } from "../types.js";

export interface AdapterContext {
  cwd: string;
  homeDir: string;
  projectRoot: string | null;
}

export interface AgentAdapter {
  /** Stable id: `opencode` | `codex` | `claude` | ... */
  id: string;
  /** Display name. */
  label: string;
  /** Docs URL(s) the implementation was verified against. */
  docRefs: string[];
  /** True when this agent plausibly applies to `cwd`. */
  detect(ctx: AdapterContext): Promise<boolean>;
  /** List every context source candidate (existing or referenced). */
  discover(ctx: AdapterContext): Promise<ContextSource[]>;
  /** Partition into loaded / not-loaded and compute token breakdown. */
  resolve(ctx: AdapterContext, sources: ContextSource[]): Promise<EffectiveContext>;
}

/** Read file content for discovered sources (shared by scanner). */
export type ContentLoader = (source: ContextSource) => Promise<string | null>;
