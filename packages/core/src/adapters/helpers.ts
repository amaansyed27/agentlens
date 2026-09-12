/**
 * Shared helpers for adapters: build ContextSource entries backed by files.
 */
import * as path from "node:path";
import { describeText } from "../tokenizer.js";
import type { ContextSource, SourceKind } from "../types.js";
import { exists, readTextSafe } from "../fs.js";

export interface FileSourceOptions {
  agentId: string;
  kind: SourceKind;
  label?: string;
  scope?: string;
  alwaysLoaded: boolean;
  reason: string;
  unverified?: boolean;
  detail?: string;
}

export async function fileSource(absPath: string, opts: FileSourceOptions): Promise<ContextSource> {
  const text = await readTextSafe(absPath);
  const stats = text === null ? { chars: 0, lines: 0, words: 0, tokens: 0 } : describeText(text);
  const ok = text !== null;
  return {
    id: `${opts.agentId}:${opts.kind}:${absPath}`,
    agentId: opts.agentId,
    kind: opts.kind,
    label: opts.label ?? path.basename(absPath),
    path: absPath,
    exists: ok,
    alwaysLoaded: ok && opts.alwaysLoaded,
    tokens: stats.tokens,
    chars: stats.chars,
    lines: stats.lines,
    scope: opts.scope,
    reason: ok ? opts.reason : `referenced but missing: ${opts.reason}`,
    unverified: opts.unverified,
    detail: opts.detail,
  };
}

export async function missingSource(absPath: string, opts: FileSourceOptions): Promise<ContextSource> {
  const has = await exists(absPath);
  if (has) return fileSource(absPath, opts);
  return {
    id: `${opts.agentId}:${opts.kind}:${absPath}`,
    agentId: opts.agentId,
    kind: opts.kind,
    label: opts.label ?? path.basename(absPath),
    path: absPath,
    exists: false,
    alwaysLoaded: false,
    tokens: 0,
    chars: 0,
    lines: 0,
    scope: opts.scope,
    reason: `not present (${opts.reason})`,
    unverified: opts.unverified,
    detail: opts.detail,
  };
}

/** Minimal JSONC strip (comments + trailing commas) for opencode.json. */
export function parseJsonc(raw: string): { data: unknown; error: string | null } {
  try {
    const noComments = raw
      .split("\n")
      .map((l) => {
        const idx = l.indexOf("//");
        if (idx === -1) return l;
        // Keep `https://` inside strings: only strip `//` outside quotes.
        let inStr = false;
        for (let i = 0; i < l.length - 1; i++) {
          const c = l[i];
          if (c === '"' && l[i - 1] !== "\\") inStr = !inStr;
          if (!inStr && c === "/" && l[i + 1] === "/") return l.slice(0, i);
        }
        return l;
      })
      .join("\n")
      .replace(/,\s*([}\]])/g, "$1");
    return { data: JSON.parse(noComments), error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Expand a small subset of glob patterns (`*` single segment) for instructions. */
export async function expandSimpleGlob(pattern: string, base: string): Promise<string[]> {
  const { promises: fs } = await import("node:fs");
  if (!pattern.includes("*")) {
    const full = path.isAbsolute(pattern) ? pattern : path.join(base, pattern);
    return (await exists(full)) ? [full] : [];
  }
  const dirPart = pattern.slice(0, pattern.indexOf("*"));
  const rest = pattern.slice(pattern.indexOf("*"));
  const dirAbs = path.isAbsolute(dirPart) ? dirPart : path.join(base, dirPart);
  const parent = path.dirname(path.join(dirAbs, "x"));
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch {
    return [];
  }
  const suffix = rest.replace(/^\*+/, "");
  const out: string[] = [];
  for (const e of entries) {
    if (suffix && !e.endsWith(suffix) && !suffix.startsWith("/")) continue;
    const cand = path.join(parent, e, suffix.replace(/^\//, ""));
    if (await exists(cand)) out.push(cand);
  }
  return out.sort();
}
