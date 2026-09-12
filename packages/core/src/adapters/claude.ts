/**
 * Claude Code adapter.
 *
 * Verified against (checked 2026-09):
 * - https://code.claude.com/docs/en/memory — four scopes (managed policy,
 *   user `~/.claude/CLAUDE.md`, project `./CLAUDE.md` (+ `./.claude/CLAUDE.md`),
 *   local `CLAUDE.local.md`); upward walk from cwd, root-down concatenation,
 *   `CLAUDE.local.md` after `CLAUDE.md` per directory; subdirectory files load
 *   lazily on file read; `@path` imports (relative to importing file, max
 *   4 hops, still count as launch context); rule files under .claude/rules
 *   with optional path scoping; `claudeMdExcludes`; project-root CLAUDE.md survives
 *   compaction. Claude does NOT read AGENTS.md natively (import it explicitly).
 */
import * as path from "node:path";
import type { ContextSource, EffectiveContext } from "../types.js";
import { estimateMcpTokens } from "../tokenizer.js";
import {
  ancestorsRootFirst,
  exists,
  findAgentFiles,
  findMarkdownRecursive,
  findSkillFiles,
  readJsonSafe,
  readTextSafe,
} from "../fs.js";
import type { AdapterContext, AgentAdapter } from "./adapter.js";
import { fileSource, missingSource } from "./helpers.js";

export const CLAUDE_DOCS = ["https://code.claude.com/docs/en/memory"];

const IMPORT_RE = /(?:^|\s)@([^\s`'"()[\]{};]+)/gm;
const MAX_IMPORT_DEPTH = 4;

function inCodeFence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const fences = (before.match(/```/g) ?? []).length;
  return fences % 2 === 1;
}

/** `@path` targets in a file, resolved relative to the importing file. */
export function extractImports(text: string, fromFile: string): string[] {
  const out: string[] = [];
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(text)) !== null) {
    if (inCodeFence(text, m.index)) continue;
    let target = m[1].replace(/[.,:;!?]+$/, "");
    if (!target || target.startsWith("@")) continue;
    target = target.replace(/^~/, process.env.HOME ?? "~");
    const abs = path.isAbsolute(target) ? target : path.join(path.dirname(fromFile), target);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

async function claudeMdExcludes(ctx: AdapterContext): Promise<string[]> {
  const out: string[] = [];
  const settingsPaths = [
    path.join(ctx.projectRoot ?? ctx.cwd, ".claude", "settings.json"),
    path.join(ctx.homeDir, ".claude", "settings.json"),
  ];
  for (const sp of settingsPaths) {
    const { data } = await readJsonSafe<{ claudeMdExcludes?: string[] }>(sp);
    if (data?.claudeMdExcludes && Array.isArray(data.claudeMdExcludes)) {
      out.push(...data.claudeMdExcludes.filter((x): x is string => typeof x === "string"));
    }
  }
  return out;
}

function excluded(abs: string, patterns: string[], root: string): boolean {
  const rel = path.relative(root, abs).split(path.sep).join("/");
  return patterns.some((p) => {
    const norm = p.split(path.sep).join("/");
    if (norm.includes("*")) {
      const re = new RegExp("^" + norm.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return re.test(rel);
    }
    return rel === norm || rel.startsWith(norm.replace(/\/$/, "") + "/");
  });
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  docRefs: CLAUDE_DOCS,

  async detect(ctx) {
    if (await exists(path.join(ctx.cwd, ".claude"))) return true;
    for (const n of ["CLAUDE.md", "CLAUDE.local.md"]) {
      if (await exists(path.join(ctx.cwd, n))) return true;
    }
    if (await exists(path.join(ctx.homeDir, ".claude"))) return true;
    return false;
  },

  async discover(ctx) {
    const out: ContextSource[] = [];
    const warnings: string[] = [];
    const root = ctx.projectRoot ?? ctx.cwd;
    const excludes = await claudeMdExcludes(ctx);

    // 1. User scope.
    const userClaude = path.join(ctx.homeDir, ".claude", "CLAUDE.md");
    out.push(
      await missingSource(userClaude, {
        agentId: "claude",
        kind: "global",
        label: "user CLAUDE.md",
        alwaysLoaded: true,
        reason: "user instruction (applies to every project)",
      }),
    );

    // 2. Upward walk: fs-root -> cwd, CLAUDE.md then CLAUDE.local.md per dir.
    const chain = ancestorsRootFirst(ctx.cwd).filter(
      (d) => path.resolve(root).startsWith(path.resolve(d)) || path.resolve(d).startsWith(path.resolve(root)) || d === path.resolve(ctx.cwd),
    );
    const upward = chain.filter((d) => {
      const rel = path.relative(root, d);
      return rel === "" || (!rel.startsWith("..") && path.resolve(d).startsWith(path.resolve(root))) || ancestorsRootFirst(root).includes(d);
    });
    const seen = new Set<string>();
    for (const dir of ancestorsRootFirst(ctx.cwd)) {
      // Only dirs at or above cwd that are also at/above root... simpler: dirs
      // on the path from root to cwd plus user-level ancestors already covered.
      const inProject = dir === root || dir.startsWith(root + path.sep);
      const aboveRoot = root.startsWith(dir + path.sep) || dir === path.parse(dir).root;
      if (!inProject && !isOnPath(dir, root, ctx.cwd)) continue;
      void aboveRoot;
      for (const name of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
        const p = path.join(dir, name);
        if (seen.has(p) || excluded(p, excludes, root)) continue;
        seen.add(p);
        if (await exists(p)) {
          const isLocal = name.includes("local");
          const isCwd = path.resolve(dir) === path.resolve(ctx.cwd);
          out.push(
            await fileSource(p, {
              agentId: "claude",
              kind: isCwd && !isLocal ? "project" : isLocal ? "directory" : dir === root ? "project" : "directory",
              label: path.relative(ctx.cwd, p) || name,
              scope: dir,
              alwaysLoaded: true,
              reason: isLocal
                ? "personal project notes (loaded after CLAUDE.md at the same level)"
                : isCwd
                  ? "project instruction"
                  : "ancestor instruction (concatenated root-down; nearer wins)",
            }),
          );
        }
      }
    }
    void upward;

    // 3. AGENTS.md is NOT native: surface as not-loaded with guidance.
    const agentsMd = path.join(root, "AGENTS.md");
    if (await exists(agentsMd)) {
      const imported = await isImportedByClaude(out);
      if (!imported) {
        const s = await fileSource(agentsMd, {
          agentId: "claude",
          kind: "project",
          label: "AGENTS.md",
          alwaysLoaded: false,
          reason: "Claude Code does not read AGENTS.md natively — import it via `@AGENTS.md` in CLAUDE.md",
        });
        s.alwaysLoaded = false;
        s.exists = true;
        out.push(s);
      }
    }

    // 4. `@path` imports (recursive, max 4 hops, launch context).
    const imported = await resolveImports(out, ctx, 0);
    out.push(...imported);

    // 5. Rules: .claude/rules/*.md (+ user rules). `paths` frontmatter => conditional.
    const ruleFiles = [
      ...(await findMarkdownRecursive(path.join(root, ".claude", "rules"), 6)),
      ...(await findMarkdownRecursive(path.join(ctx.homeDir, ".claude", "rules"), 6)),
    ];
    for (const f of ruleFiles) {
      if (excluded(f, excludes, root)) continue;
      const text = (await readTextSafe(f)) ?? "";
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      const pathsLine = fm?.[1].match(/^paths\s*:\s*(.+)$/m)?.[1]?.trim();
      const scoped = Boolean(pathsLine && pathsLine !== "" && pathsLine !== "[]");
      out.push(
        await fileSource(f, {
          agentId: "claude",
          kind: "skill",
          label: `rule:${path.relative(path.join(root, ".claude", "rules"), f).replace(/\\/g, "/")}`,
          alwaysLoaded: !scoped,
          reason: scoped
            ? `path-scoped rule (loads when Claude touches ${pathsLine})`
            : "rule (always loaded; no `paths` scoping)",
        }),
      );
    }

    // 6. Subagents: .claude/agents/*.md — dynamic.
    for (const f of await findAgentFiles([
      path.join(root, ".claude", "agents"),
      path.join(ctx.homeDir, ".claude", "agents"),
    ])) {
      out.push(
        await fileSource(f, {
          agentId: "claude",
          kind: "agent",
          label: `agent:${path.basename(f, ".md")}`,
          alwaysLoaded: false,
          reason: "subagent definition (loaded when delegated)",
        }),
      );
    }

    // 7. Skills.
    for (const f of await findSkillFiles([
      path.join(root, ".claude", "skills"),
      path.join(ctx.homeDir, ".claude", "skills"),
    ])) {
      out.push(
        await fileSource(f, {
          agentId: "claude",
          kind: "skill",
          label: `skill:${path.basename(path.dirname(f))}`,
          alwaysLoaded: false,
          reason: "skill (loaded on demand)",
        }),
      );
    }

    // 8. Subdirectory CLAUDE.md below cwd — lazy (dynamic, not launch-loaded).
    const sub = (await findMarkdownRecursive(ctx.cwd, 4)).filter(
      (f) =>
        path.basename(f) === "CLAUDE.md" &&
        path.resolve(path.dirname(f)) !== path.resolve(ctx.cwd) &&
        path.dirname(path.resolve(f)).startsWith(path.resolve(ctx.cwd) + path.sep),
    );
    for (const f of sub.slice(0, 50)) {
      if (seen.has(f)) continue;
      const s = await fileSource(f, {
        agentId: "claude",
        kind: "dynamic",
        label: path.relative(ctx.cwd, f),
        scope: path.dirname(f),
        alwaysLoaded: false,
        reason: "nested instruction below cwd — loads on demand when Claude reads that subtree",
      });
      s.exists = true;
      s.alwaysLoaded = false;
      out.push(s);
    }

    // 9. MCP servers from .claude.json / settings.
    for (const name of await readClaudeMcp(ctx, warnings)) {
      out.push({
        id: `claude:mcp:${name}`,
        agentId: "claude",
        kind: "mcp",
        label: `mcp:${name}`,
        exists: true,
        alwaysLoaded: true,
        tokens: estimateMcpTokens(8, 2400),
        chars: 2400,
        lines: 0,
        reason: "MCP server tool schemas (estimated; live schemas require a running server)",
        unverified: true,
        detail: "unverified: estimated without connecting to the server",
      });
    }

    (out as unknown as { __warnings?: string[] }).__warnings = warnings;
    return out;
  },

  async resolve(ctx, sources) {
    const warnings: string[] = (sources as unknown as { __warnings?: string[] }).__warnings ?? [];
    const rank = (s: ContextSource) =>
      s.kind === "global" ? 0 : s.kind === "project" ? 1 : s.kind === "directory" ? 2 : s.kind === "instruction" ? 3 : 5;
    const loaded = sources
      .filter((s) => s.exists && s.alwaysLoaded)
      .sort((a, b) => rank(a) - rank(b) || (a.path ?? "").localeCompare(b.path ?? ""));
    const notLoaded = sources.filter((s) => !(s.exists && s.alwaysLoaded));
    return { agentId: "claude", cwd: ctx.cwd, loaded, notLoaded, breakdown: breakdown(sources.filter((s) => s.exists)), warnings };
  },
};

function isOnPath(dir: string, root: string, cwd: string): boolean {
  const d = path.resolve(dir);
  // dir is on the root->cwd spine (ancestor of cwd at/below root's parent chain).
  return (
    (path.resolve(cwd) === d || path.resolve(cwd).startsWith(d + path.sep)) &&
    (d === path.resolve(root) || path.resolve(root).startsWith(d + path.sep) || d.startsWith(path.resolve(root) + path.sep))
  );
}

async function isImportedByClaude(sources: ContextSource[]): Promise<boolean> {
  for (const s of sources) {
    if (!s.path || !s.exists) continue;
    const text = await readTextSafe(s.path);
    if (text && /@AGENTS\.md/.test(text)) return true;
  }
  return false;
}

async function resolveImports(
  sources: ContextSource[],
  ctx: AdapterContext,
  depth: number,
): Promise<ContextSource[]> {
  if (depth >= MAX_IMPORT_DEPTH) return [];
  const out: ContextSource[] = [];
  const queue = sources.filter((s) => s.path && s.exists);
  for (const s of queue) {
    const text = (await readTextSafe(s.path!)) ?? "";
    for (const target of extractImports(text, s.path!)) {
      if (sources.concat(out).some((o) => o.path === target)) continue;
      if (await exists(target)) {
        const isDir = (await import("../fs.js")).isDir(target);
        if (await isDir) continue;
        out.push(
          await fileSource(target, {
            agentId: "claude",
            kind: "instruction",
            label: path.relative(ctx.cwd, target),
            alwaysLoaded: true,
            reason: `@import from ${path.relative(ctx.cwd, s.path!)} (launch context, hop ${depth + 1})`,
          }),
        );
      } else {
        out.push({
          id: `claude:import:${target}`,
          agentId: "claude",
          kind: "instruction",
          label: target,
          path: target,
          exists: false,
          alwaysLoaded: false,
          tokens: 0,
          chars: 0,
          lines: 0,
          reason: `@import from ${s.path} points to a missing file`,
        });
      }
    }
  }
  if (out.length > 0) {
    const deeper = await resolveImports(out, ctx, depth + 1);
    out.push(...deeper);
  }
  return out;
}

async function readClaudeMcp(ctx: AdapterContext, warnings: string[]): Promise<string[]> {
  const names = new Set<string>();
  const candidates = [
    path.join(ctx.projectRoot ?? ctx.cwd, ".claude.json"),
    path.join(ctx.projectRoot ?? ctx.cwd, ".claude", "settings.json"),
    path.join(ctx.homeDir, ".claude.json"),
    path.join(ctx.homeDir, ".claude", "settings.json"),
  ];
  for (const c of candidates) {
    const { data, error } = await readJsonSafe<Record<string, unknown>>(c);
    if (error) {
      warnings.push(`malformed config: ${c} (${error})`);
      continue;
    }
    const rec = (data ?? {}) as Record<string, unknown>;
    const mcp = rec.mcpServers ?? rec.mcp;
    if (mcp && typeof mcp === "object") {
      for (const k of Object.keys(mcp as Record<string, unknown>)) names.add(k);
    }
  }
  return [...names].sort();
}

function breakdown(sources: ContextSource[]) {
  let instructions = 0;
  let skills = 0;
  let tools = 0;
  let other = 0;
  let alwaysLoaded = 0;
  let conditional = 0;
  for (const s of sources) {
    if (s.kind === "skill") skills += s.tokens;
    else if (s.kind === "mcp") tools += s.tokens;
    else if (["global", "project", "directory", "instruction", "dynamic"].includes(s.kind)) instructions += s.tokens;
    else other += s.tokens;
    if (s.alwaysLoaded) alwaysLoaded += s.tokens;
    else conditional += s.tokens;
  }
  return { instructions, skills, tools, other, alwaysLoaded, conditional, total: instructions + skills + tools + other };
}
