/**
 * Core orchestration: scanProject / explainPath / compareAgents.
 * CLI-free: no stdout, no colors, no process access (except env for home).
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { findConflicts } from "./conflicts.js";
import { findDuplicates } from "./similarity.js";
import { effectiveHomeDir, findGitRoot, readTextSafe } from "./fs.js";
import type {
  AdapterContext,
  AgentAdapter,
} from "./adapters/adapter.js";
import { getAdapter, listAdapters } from "./adapters/registry.js";
import type {
  DiffReport,
  EffectiveContext,
  ScanOptions,
  ScanReport,
} from "./types.js";

async function buildCtx(cwd: string, homeDir?: string): Promise<AdapterContext> {
  const abs = path.resolve(cwd);
  return {
    cwd: abs,
    homeDir: effectiveHomeDir(homeDir),
    projectRoot: await findGitRoot(abs),
  };
}

async function runAdapter(adapter: AgentAdapter, ctx: AdapterContext): Promise<import("./types.js").AgentScan> {
  const detected = await adapter.detect(ctx);
  const sources = await adapter.discover(ctx);
  const resolved = await adapter.resolve(ctx, sources);
  return { ...resolved, detected };
}

/** Scan a project directory with all (or one) agent adapters. */
export async function scanProject(opts: ScanOptions = {}): Promise<ScanReport> {
  const ctx = await buildCtx(opts.cwd ?? process.cwd(), opts.homeDir);
  const adapters = opts.agent ? [getAdapter(opts.agent)].filter((a): a is AgentAdapter => Boolean(a)) : listAdapters();
  if (opts.agent && adapters.length === 0) {
    throw new Error(`unknown agent: ${opts.agent} (expected one of ${listAdapters().map((a) => a.id).join(", ")})`);
  }
  const agents: import("./types.js").AgentScan[] = [];
  for (const a of adapters) agents.push(await runAdapter(a, ctx));

  // Duplicates + conflicts over instruction text across agents — including
  // conditional sources (skills, agents), since duplication wastes tokens
  // whenever those load. MCP schemas are estimates, not text: excluded.
  const docs: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const ag of agents) {
    for (const s of [...ag.loaded, ...ag.notLoaded]) {
      if (!s.path || seen.has(s.path)) continue;
      if (s.kind === "mcp") continue;
      if (!s.exists) continue;
      // Dedupe by canonical path so symlinked copies of one file are read once.
      let canon: string;
      try {
        canon = await fs.realpath(s.path);
      } catch {
        canon = path.resolve(s.path);
      }
      if (seen.has(canon)) continue;
      seen.add(s.path);
      seen.add(canon);
      const text = await readTextSafe(s.path);
      if (text !== null && text.trim()) docs.push({ path: s.path, text });
    }
  }
  const duplicates = findDuplicates(docs).map((d) => ({ ...d }));
  const conflicts = findConflicts(docs);

  return {
    version: 1,
    cwd: ctx.cwd,
    agents,
    duplicates,
    conflicts,
    generatedAt: new Date().toISOString(),
  };
}

/** Resolve one agent's context (used by tree/tokens/explain). */
export async function resolveAgent(cwd: string, agentId: string, homeDir?: string): Promise<EffectiveContext> {
  const adapter = getAdapter(agentId);
  if (!adapter) throw new Error(`unknown agent: ${agentId}`);
  const ctx = await buildCtx(cwd, homeDir);
  const sources = await adapter.discover(ctx);
  return adapter.resolve(ctx, sources);
}

export interface ExplainOptions {
  cwd?: string;
  agent?: string;
  target: string;
  homeDir?: string;
}

/** Explain WHY the agent sees each instruction for TARGET path. */
export async function explainPath(opts: ExplainOptions): Promise<import("./types.js").ExplainReport> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const agentId = opts.agent ?? "opencode";
  const resolved = await resolveAgent(cwd, agentId, opts.homeDir);
  const target = path.resolve(cwd, opts.target);
  const loaded: { path: string; reason: string; tokens: number }[] = [];
  const notLoaded: { path: string; reason: string }[] = [];

  for (const s of resolved.loaded) {
    if (!s.path) {
      loaded.push({ path: s.label, reason: s.reason, tokens: s.tokens });
      continue;
    }
    if (covers(s, target)) {
      loaded.push({ path: s.path, reason: withWhy(s.reason, target, cwd), tokens: s.tokens });
    } else {
      notLoaded.push({ path: s.path, reason: `does not scope to ${rel(target, cwd)} (${s.reason})` });
    }
  }
  for (const s of resolved.notLoaded) {
    if (s.kind === "dynamic" && s.scope && (target === s.scope || target.startsWith(s.scope + path.sep))) {
      loaded.push({
        path: s.path ?? s.label,
        reason: `loads on demand when the agent reads ${rel(target, cwd)} (${s.reason})`,
        tokens: s.tokens,
      });
    } else {
      notLoaded.push({ path: s.path ?? s.label, reason: s.reason });
    }
  }
  return { version: 1, agentId, cwd, target, loaded, notLoaded };
}

function covers(s: { kind: string; scope?: string; path?: string }, target: string): boolean {
  if (s.kind === "global" || s.kind === "mcp") return true;
  const scope = s.scope ?? (s.path ? path.dirname(s.path) : undefined);
  if (!scope) return true;
  const sc = path.resolve(scope);
  // Ancestor scope covers the target; a file scope covers its own subtree.
  return target === sc || target.startsWith(sc + path.sep);
}

function withWhy(reason: string, target: string, cwd: string): string {
  return `${reason} — applies to ${rel(target, cwd)}`;
}

function rel(p: string, cwd: string): string {
  const r = path.relative(cwd, p);
  return r === "" ? "." : r;
}

export interface CompareAgentsOptions {
  cwd?: string;
  left: string;
  right: string;
  homeDir?: string;
}

/** Show why two agents may behave differently in the same repo. */
export async function compareAgents(opts: CompareAgentsOptions): Promise<DiffReport> {
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const left = await resolveAgent(cwd, opts.left, opts.homeDir);
  const right = await resolveAgent(cwd, opts.right, opts.homeDir);

  const key = (s: { label: string; path?: string }) => (s.path ? baseKey(s.path) : s.label);
  const lMap = new Map(left.loaded.map((s) => [key(s), s]));
  const rMap = new Map(right.loaded.map((s) => [key(s), s]));
  const labels = [...new Set([...lMap.keys(), ...rMap.keys()])].sort();
  const rows = labels.map((label) => ({ label, left: lMap.has(label), right: rMap.has(label) }));

  const differences: DiffReport["differences"] = [];
  // Presence differences.
  for (const r of rows) {
    if (r.left && !r.right) {
      differences.push({
        severity: "MEDIUM",
        message: `${left.agentId} receives "${r.label}" but ${right.agentId} does not`,
      });
    } else if (r.right && !r.left) {
      differences.push({
        severity: "MEDIUM",
        message: `${right.agentId} receives "${r.label}" but ${left.agentId} does not`,
      });
    }
  }
  // Value conflicts across the two contexts.
  const docs = [...left.loaded, ...right.loaded]
    .filter((s) => s.path && s.kind !== "mcp")
    .map((s) => ({ path: `${s.agentId}:${s.path}`, text: "" }));
  void docs;
  const lDocs = await docsFor(left);
  const rDocs = await docsFor(right);
  const all = new Map<string, string>();
  for (const d of [...lDocs, ...rDocs]) all.set(d.path, d.text);
  const conflicts = findConflicts([...all.entries()].map(([p, text]) => ({ path: p, text })));
  for (const c of conflicts) {
    const agents = new Set(c.sources.map((s) => s.path.split(":")[0]));
    if (agents.size > 1) {
      differences.push({
        severity: c.severity,
        message: `${c.message} (${c.sources.map((s) => `${s.path} = "${s.value}"`).join(" vs ")})`,
      });
    }
  }
  if (Math.abs(left.breakdown.total - right.breakdown.total) >= 1000) {
    differences.push({
      severity: "LOW",
      message: `Estimated context differs by ${Math.abs(left.breakdown.total - right.breakdown.total).toLocaleString()} tokens`,
    });
  }

  return {
    version: 1,
    cwd,
    left: opts.left,
    right: opts.right,
    rows,
    tokens: { left: left.breakdown.total, right: right.breakdown.total },
    differences: differences.slice(0, 20),
  };
}

async function docsFor(ec: EffectiveContext): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const s of ec.loaded) {
    if (!s.path || s.kind === "mcp") continue;
    const text = await readTextSafe(s.path);
    if (text !== null && text.trim()) out.push({ path: `${s.agentId}:${s.path}`, text });
  }
  return out;
}

function baseKey(p: string): string {
  return path.basename(p);
}
