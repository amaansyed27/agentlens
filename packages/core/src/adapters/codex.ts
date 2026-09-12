/**
 * Codex adapter.
 *
 * Verified against (checked 2026-09):
 * - https://developers.openai.com/codex/guides/agents-md — global
 *   `$CODEX_HOME/AGENTS.override.md` else `AGENTS.md` (first non-empty);
 *   project walk from git root down to cwd, one file per directory
 *   (`AGENTS.override.md` > `AGENTS.md` > `project_doc_fallback_filenames`);
 *   root-down concatenation (deeper wins); empty files skipped; 32 KiB
 *   `project_doc_max_bytes` cap with truncation.
 * - codex-rs `core/src/agents_md.rs` — same algorithm in source.
 */
import * as path from "node:path";
import type { ContextSource, EffectiveContext } from "../types.js";
import { estimateMcpTokens } from "../tokenizer.js";
import { exists, findSkillFiles, readTextSafe } from "../fs.js";
import type { AdapterContext, AgentAdapter } from "./adapter.js";
import { fileSource, missingSource } from "./helpers.js";

export const CODEX_DOCS = [
  "https://developers.openai.com/codex/guides/agents-md",
  "https://github.com/openai/codex/blob/main/codex-rs/core/src/agents_md.rs",
];

const DEFAULT_MAX_BYTES = 32 * 1024;

function codexHome(ctx: AdapterContext): string {
  return process.env.CODEX_HOME ?? path.join(ctx.homeDir, ".codex");
}

interface CodexConfig {
  fallbacks: string[];
  maxBytes: number;
  malformed: boolean;
}

/** Minimal TOML read: only the two keys we care about. */
async function readCodexConfig(home: string): Promise<CodexConfig> {
  const cfg: CodexConfig = { fallbacks: [], maxBytes: DEFAULT_MAX_BYTES, malformed: false };
  const raw = await readTextSafe(path.join(home, "config.toml"));
  if (raw === null) return cfg;
  try {
    const fb = raw.match(/project_doc_fallback_filenames\s*=\s*\[([^\]]*)\]/);
    if (fb) {
      cfg.fallbacks = [...fb[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    }
    const mb = raw.match(/project_doc_max_bytes\s*=\s*(\d+)/);
    if (mb) cfg.maxBytes = parseInt(mb[1], 10);
  } catch {
    cfg.malformed = true;
  }
  return cfg;
}

async function firstNonEmpty(files: string[]): Promise<string | null> {
  for (const f of files) {
    const t = await readTextSafe(f);
    if (t !== null && t.trim() !== "") return f;
  }
  return null;
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex",
  docRefs: CODEX_DOCS,

  async detect(ctx) {
    const home = codexHome(ctx);
    if (await exists(path.join(ctx.cwd, ".codex"))) return true;
    for (const n of ["AGENTS.md", "AGENTS.override.md"]) {
      if (await exists(path.join(ctx.cwd, n))) return true;
    }
    if (await exists(home)) return true;
    return false;
  },

  async discover(ctx) {
    const out: ContextSource[] = [];
    const warnings: string[] = [];
    const home = codexHome(ctx);
    const cfg = await readCodexConfig(home);
    if (cfg.malformed) warnings.push(`malformed config: ${path.join(home, "config.toml")}`);

    // 1. Global scope: AGENTS.override.md else AGENTS.md (first non-empty).
    const globalPick =
      (await firstNonEmpty([path.join(home, "AGENTS.override.md"), path.join(home, "AGENTS.md")])) ??
      path.join(home, "AGENTS.md");
    out.push(
      await missingSource(globalPick, {
        agentId: "codex",
        kind: "global",
        label: `global ${path.basename(globalPick)}`,
        alwaysLoaded: true,
        reason: "global instruction (override file wins when both exist)",
      }),
    );

    // 2. Project scope: git root -> cwd, one file per directory.
    const root = ctx.projectRoot;
    const dirs: string[] = [];
    if (root) {
      let cur = path.resolve(ctx.cwd);
      const chain: string[] = [];
      while (true) {
        chain.push(cur);
        if (cur === path.resolve(root)) break;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      dirs.push(...chain.reverse());
    } else {
      dirs.push(path.resolve(ctx.cwd));
    }
    const chainFiles: string[] = [];
    for (const dir of dirs) {
      const candidates = [
        path.join(dir, "AGENTS.override.md"),
        path.join(dir, "AGENTS.md"),
        ...cfg.fallbacks.map((f) => path.join(dir, f)),
      ];
      const pick = await firstNonEmpty(candidates);
      if (pick) {
        chainFiles.push(pick);
        const isRoot = root !== null && path.resolve(dir) === path.resolve(root);
        out.push(
          await fileSource(pick, {
            agentId: "codex",
            kind: isRoot ? "project" : "directory",
            label: path.relative(ctx.cwd, pick) || path.basename(pick),
            scope: dir,
            alwaysLoaded: true,
            reason: isRoot
              ? "project instruction (repo root)"
              : "nested instruction (concatenated root-down; deeper wins)",
          }),
        );
      }
    }

    // 3. Apply the byte budget: mark truncated tail.
    let remaining = cfg.maxBytes;
    const globalText = (await readTextSafe(globalPick)) ?? "";
    remaining -= Buffer.byteLength(globalText, "utf8");
    for (const s of out) {
      if (s.kind === "global" || !s.path) continue;
      const bytes = Buffer.byteLength((await readTextSafe(s.path)) ?? "", "utf8");
      if (remaining <= 0) {
        s.alwaysLoaded = false;
        s.reason = `over project_doc_max_bytes budget (${cfg.maxBytes} bytes) — truncated by Codex`;
        s.detail = "truncated";
      } else if (bytes > remaining) {
        s.detail = `truncated to remaining budget (${remaining} of ${bytes} bytes)`;
        remaining = 0;
      } else {
        remaining -= bytes;
      }
    }
    if (remaining <= 0 && chainFiles.length > 0) {
      warnings.push(`instruction chain exceeds project_doc_max_bytes (${cfg.maxBytes} bytes); tail truncated`);
    }

    // 4. Skills: .codex/skills + global skills (conditional; exact surfacing unverified).
    const skillBases = [path.join(root ?? ctx.cwd, ".codex", "skills"), path.join(home, "skills")];
    for (const f of await findSkillFiles(skillBases)) {
      out.push(
        await fileSource(f, {
          agentId: "codex",
          kind: "skill",
          label: `skill:${path.basename(path.dirname(f))}`,
          alwaysLoaded: false,
          reason: "skill (loaded on demand)",
          unverified: true,
          detail: "unverified: Codex skill loading is version-dependent",
        }),
      );
    }

    // 5. MCP servers from .codex/config.toml [mcp_servers].
    const mcpRaw = await readTextSafe(path.join(root ?? ctx.cwd, ".codex", "config.toml"));
    if (mcpRaw) {
      const names = [...mcpRaw.matchAll(/\[mcp_servers\.([^\]]+)\]/g)].map((m) => m[1].trim());
      for (const name of names) {
        out.push({
          id: `codex:mcp:${name}`,
          agentId: "codex",
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
    }

    (out as unknown as { __warnings?: string[] }).__warnings = warnings;
    return out;
  },

  async resolve(ctx, sources) {
    const warnings: string[] = (sources as unknown as { __warnings?: string[] }).__warnings ?? [];
    // Order: global first, then root -> cwd.
    const order = (s: (typeof sources)[number]) =>
      s.kind === "global" ? 0 : s.kind === "mcp" ? 9 : 1;
    const loaded = sources
      .filter((s) => s.exists && s.alwaysLoaded)
      .sort((a, b) => order(a) - order(b) || (a.path ?? "").localeCompare(b.path ?? ""));
    const notLoaded = sources.filter((s) => !(s.exists && s.alwaysLoaded));
    return {
      agentId: "codex",
      cwd: ctx.cwd,
      loaded,
      notLoaded,
      breakdown: breakdown(sources.filter((s) => s.exists)),
      warnings,
    } satisfies EffectiveContext;
  },
};

function breakdown(sources: import("../types.js").ContextSource[]) {
  let instructions = 0;
  let skills = 0;
  let tools = 0;
  let other = 0;
  let alwaysLoaded = 0;
  let conditional = 0;
  for (const s of sources) {
    if (s.kind === "skill") skills += s.tokens;
    else if (s.kind === "mcp") tools += s.tokens;
    else if (s.kind === "global" || s.kind === "project" || s.kind === "directory") instructions += s.tokens;
    else other += s.tokens;
    if (s.alwaysLoaded) alwaysLoaded += s.tokens;
    else conditional += s.tokens;
  }
  return { instructions, skills, tools, other, alwaysLoaded, conditional, total: instructions + skills + tools + other };
}
