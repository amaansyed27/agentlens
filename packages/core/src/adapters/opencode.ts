/**
 * OpenCode adapter.
 *
 * Verified against (checked 2026-09):
 * - https://opencode.ai/docs/rules/ — project `AGENTS.md`, global
 *   `~/.config/opencode/AGENTS.md`, `CLAUDE.md` fallback when no `AGENTS.md`,
 *   `instructions` field in opencode.json.
 * - https://opencode.ai/v2/docs/instructions/ — V2 model: global file, upward
 *   `AGENTS.md` scan from the working location to home/project root, nested
 *   `AGENTS.md` below the location loads dynamically on file read, config
 *   `instructions` arrays are NOT merged (closest wins), V2 only recognises
 *   `AGENTS.md` (CLAUDE.md fallback does not apply in V2).
 *
 * Where V1 and V2 disagree we implement the union and mark the disputed
 * entries `unverified: true` instead of inventing precedence.
 */
import * as path from "node:path";
import type { ContextSource, EffectiveContext } from "../types.js";
import { estimateMcpTokens } from "../tokenizer.js";
import { exists, findAgentFiles, findMarkdownRecursive, findSkillFiles, readJsonSafe, walkUp } from "../fs.js";
import type { AdapterContext, AgentAdapter } from "./adapter.js";
import { expandSimpleGlob, fileSource, missingSource, parseJsonc } from "./helpers.js";

export const OPENCODE_DOCS = [
  "https://opencode.ai/docs/rules/",
  "https://opencode.ai/v2/docs/instructions/",
];

async function configPaths(ctx: AdapterContext): Promise<{ global: string; project: string[] }> {
  const xdg = process.env.XDG_CONFIG_HOME;
  const globalCfg = xdg
    ? path.join(xdg, "opencode", "AGENTS.md")
    : path.join(ctx.homeDir, ".config", "opencode", "AGENTS.md");
  const project: string[] = [];
  if (ctx.projectRoot) {
    project.push(path.join(ctx.projectRoot, "opencode.json"));
    project.push(path.join(ctx.projectRoot, "opencode.jsonc"));
    project.push(path.join(ctx.projectRoot, ".opencode", "opencode.json"));
    project.push(path.join(ctx.projectRoot, ".opencode", "opencode.jsonc"));
  } else {
    project.push(path.join(ctx.cwd, "opencode.json"));
    project.push(path.join(ctx.cwd, "opencode.jsonc"));
  }
  return { global: globalCfg, project };
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  docRefs: OPENCODE_DOCS,

  async detect(ctx) {
    if (await exists(path.join(ctx.cwd, ".opencode"))) return true;
    for (const n of ["opencode.json", "opencode.jsonc", "AGENTS.md"]) {
      if (await exists(path.join(ctx.cwd, n))) return true;
    }
    if (await exists(path.join(ctx.homeDir, ".config", "opencode"))) return true;
    return false;
  },

  async discover(ctx) {
    const out: ContextSource[] = [];
    const warnings: string[] = [];
    const { global, project } = await configPaths(ctx);

    // 1. Global instructions.
    out.push(
      await missingSource(global, {
        agentId: "opencode",
        kind: "global",
        label: "global AGENTS.md",
        alwaysLoaded: true,
        reason: "global instruction (applies to every session)",
      }),
    );

    // 2. Upward AGENTS.md chain: cwd -> project root (or home).
    const stop = ctx.projectRoot ?? ctx.homeDir;
    const chain = walkUp(ctx.cwd, path.resolve(stop) === path.resolve(ctx.cwd) ? ctx.cwd : stop);
    // Render order per V2 docs: global, then location -> root. Keep nearest-first reasoning.
    for (const dir of chain) {
      const p = path.join(dir, "AGENTS.md");
      if (await exists(p)) {
        const isCwd = path.resolve(dir) === path.resolve(ctx.cwd);
        out.push(
          await fileSource(p, {
            agentId: "opencode",
            kind: isCwd ? "project" : "directory",
            label: path.relative(ctx.cwd, p) || "AGENTS.md",
            scope: dir,
            alwaysLoaded: true,
            reason: isCwd ? "project instruction" : "ancestor directory instruction (upward scan)",
          }),
        );
      } else {
        // V1 CLAUDE.md fallback: only when AGENTS.md absent at that level.
        const fallback = path.join(dir, "CLAUDE.md");
        if (await exists(fallback)) {
          out.push(
            await fileSource(fallback, {
              agentId: "opencode",
              kind: isCwd2(dir, ctx) ? "project" : "directory",
              label: path.relative(ctx.cwd, fallback) || "CLAUDE.md",
              scope: dir,
              alwaysLoaded: true,
              reason: "fallback instruction (used only when no AGENTS.md at this level)",
              unverified: true,
              detail: "V1 fallback; V2 docs state only AGENTS.md is recognised",
            }),
          );
        }
      }
      // `.opencode/AGENTS.md` companion file.
      const companion = path.join(dir, ".opencode", "AGENTS.md");
      if (await exists(companion)) {
        out.push(
          await fileSource(companion, {
            agentId: "opencode",
            kind: "directory",
            label: path.relative(ctx.cwd, companion),
            scope: dir,
            alwaysLoaded: true,
            reason: "OpenCode-specific companion instructions",
            unverified: true,
          }),
        );
      }
    }

    // 3b. Nested AGENTS.md BELOW the working location: not part of the initial
    // upward scan (V2 docs). Discovered when the read tool touches that subtree,
    // so they are dynamic — loaded on demand, once per session.
    const below = (await findMarkdownRecursive(ctx.cwd, 5)).filter(
      (f) => path.basename(f) === "AGENTS.md",
    );
    const known = new Set(out.map((s) => s.path));
    const nested: string[] = [];
    for (const f of below) {
      if (known.has(f)) continue;
      if (path.resolve(path.dirname(f)) === path.resolve(ctx.cwd)) continue;
      nested.push(f);
    }
    if (nested.length > 50) {
      warnings.push(
        `found ${nested.length} nested AGENTS.md files below the working location; showing the first 50`,
      );
    }
    for (const f of nested.slice(0, 50)) {
      const s = await fileSource(f, {
        agentId: "opencode",
        kind: "dynamic",
        label: path.relative(ctx.cwd, f),
        scope: path.dirname(f),
        alwaysLoaded: false,
        reason: "nested instruction below working location — loads when the agent reads that subtree",
      });
      s.exists = true;
      s.alwaysLoaded = false;
      out.push(s);
    }

    // 4. `instructions` field from project/global opencode.json (closest wins).
    const configFiles = [
      ...project,
      path.join(ctx.homeDir, ".config", "opencode", "opencode.json"),
      path.join(ctx.homeDir, ".config", "opencode", "opencode.jsonc"),
    ];
    let instructions: string[] | null = null;
    let instructionsFrom = "";
    for (const cf of configFiles) {
      if (!(await exists(cf))) continue;
      const { readTextSafe } = await import("../fs.js");
      const raw = await readTextSafe(cf);
      if (raw === null) continue;
      const { data, error } = parseJsonc(raw);
      if (error || typeof data !== "object" || data === null) {
        warnings.push(`malformed config: ${cf} (${error ?? "not an object"})`);
        continue;
      }
      const d = data as Record<string, unknown>;
      if (Array.isArray(d.instructions)) {
        instructions = d.instructions.filter((x): x is string => typeof x === "string");
        instructionsFrom = cf;
        break; // closest config wins; arrays are not merged (V2 docs).
      }
      // MCP servers live in the same files — handled below.
    }
    if (instructions) {
      for (const pattern of instructions) {
        if (/^https?:\/\//.test(pattern)) {
          out.push({
            id: `opencode:instruction:${pattern}`,
            agentId: "opencode",
            kind: "instruction",
            label: pattern,
            exists: false,
            alwaysLoaded: false,
            tokens: 0,
            chars: 0,
            lines: 0,
            reason: `listed in ${instructionsFrom} instructions but URL fetching is not supported in V2`,
            unverified: true,
            detail: "unverified: V2 parses but does not resolve `instructions` URLs",
          });
          continue;
        }
        const expanded = await expandSimpleGlob(pattern, ctx.projectRoot ?? ctx.cwd);
        if (expanded.length === 0) {
          out.push({
            id: `opencode:instruction:${pattern}`,
            agentId: "opencode",
            kind: "instruction",
            label: pattern,
            exists: false,
            alwaysLoaded: false,
            tokens: 0,
            chars: 0,
            lines: 0,
            reason: `listed in ${instructionsFrom} instructions but matched no files`,
          });
        }
        for (const f of expanded) {
          out.push(
            await fileSource(f, {
              agentId: "opencode",
              kind: "instruction",
              label: path.relative(ctx.cwd, f),
              alwaysLoaded: true,
              reason: `explicit instructions entry in ${path.basename(instructionsFrom)}`,
            }),
          );
        }
      }
    }

    // 5. Agent definitions: .opencode/agents/*.md (+ project agents/ fallback).
    const agentDirs = [
      path.join(ctx.projectRoot ?? ctx.cwd, ".opencode", "agents"),
      path.join(ctx.projectRoot ?? ctx.cwd, ".opencode", "agent"),
      path.join(ctx.homeDir, ".config", "opencode", "agents"),
    ];
    for (const f of await findAgentFiles(agentDirs)) {
      out.push(
        await fileSource(f, {
          agentId: "opencode",
          kind: "agent",
          label: `agent:${path.basename(f, ".md")}`,
          alwaysLoaded: false,
          reason: "agent definition (loaded when the agent is invoked)",
        }),
      );
    }

    // 6. Skills (descriptions always visible; bodies on demand — conditional).
    const skillBases = [
      path.join(ctx.projectRoot ?? ctx.cwd, "skills"),
      path.join(ctx.projectRoot ?? ctx.cwd, ".opencode", "skills"),
      path.join(ctx.homeDir, ".config", "opencode", "skills"),
    ];
    for (const f of await findSkillFiles(skillBases)) {
      const s = await fileSource(f, {
        agentId: "opencode",
        kind: "skill",
        label: `skill:${path.basename(path.dirname(f))}`,
        alwaysLoaded: false,
        reason: "skill (description in context; body loads on demand)",
        unverified: true,
        detail: "unverified: exact skill surfacing varies by version",
      });
      out.push(s);
    }

    // 7. MCP servers from opencode.json `mcp` / `mcpServers`.
    const mcpNames = await readMcpServers(configFiles);
    for (const name of mcpNames) {
      out.push({
        id: `opencode:mcp:${name}`,
        agentId: "opencode",
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
    const loaded = sources.filter((s) => s.exists && s.alwaysLoaded);
    const notLoaded = sources.filter((s) => !(s.exists && s.alwaysLoaded));
    return {
      agentId: "opencode",
      cwd: ctx.cwd,
      loaded: orderOpenCode(loaded),
      notLoaded,
      breakdown: breakdown(sources.filter((s) => s.exists)),
      warnings,
    };
  },
};

function isCwd2(dir: string, ctx: AdapterContext): boolean {
  return path.resolve(dir) === path.resolve(ctx.cwd);
}

async function readMcpServers(configFiles: string[]): Promise<string[]> {
  for (const cf of configFiles) {
    const { data } = await readJsonSafe<Record<string, unknown>>(cf);
    if (!data) continue;
    // JSONC comments would fail strict parse; retry lenient.
    const rec = data as Record<string, unknown>;
    const mcp = rec.mcp ?? rec.mcpServers ?? rec.servers;
    if (mcp && typeof mcp === "object") return Object.keys(mcp as Record<string, unknown>);
  }
  // Lenient JSONC retry for the first existing file.
  for (const cf of configFiles) {
    if (!(await exists(cf))) continue;
    const { readTextSafe } = await import("../fs.js");
    const raw = await readTextSafe(cf);
    if (!raw) continue;
    const { data } = parseJsonc(raw);
    const rec = (data ?? {}) as Record<string, unknown>;
    const mcp = rec.mcp ?? rec.mcpServers;
    if (mcp && typeof mcp === "object") return Object.keys(mcp as Record<string, unknown>);
  }
  return [];
}

function orderOpenCode(loaded: import("../types.js").ContextSource[]) {
  const rank = (s: import("../types.js").ContextSource) =>
    s.kind === "global" ? 0 : s.kind === "instruction" ? 4 : s.kind === "mcp" ? 5 : 2;
  return [...loaded].sort((a, b) => rank(a) - rank(b) || (a.path ?? "").localeCompare(b.path ?? ""));
}

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
    else if (s.kind === "global" || s.kind === "project" || s.kind === "directory" || s.kind === "instruction")
      instructions += s.tokens;
    else other += s.tokens;
    if (s.alwaysLoaded) alwaysLoaded += s.tokens;
    else conditional += s.tokens;
  }
  return {
    instructions,
    skills,
    tools,
    other,
    alwaysLoaded,
    conditional,
    total: instructions + skills + tools + other,
  };
}
