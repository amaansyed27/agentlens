/** Small cross-platform fs helpers. Symlink-aware, never throws on missing. */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function effectiveHomeDir(explicit?: string): string {
  return explicit ?? process.env.AGENTLENS_HOME ?? os.homedir();
}

export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(home, p.slice(2));
  return p;
}

/** True if path exists (follows symlinks). */
export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** Read text file; returns null when missing/unreadable. Never throws. */
export async function readTextSafe(p: string): Promise<string | null> {
  try {
    const text = await fs.readFile(p, "utf8");
    // Strip BOM so markers like `#`, `@import`s and frontmatter parse cleanly.
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

export interface JsonRead<T = unknown> {
  data: T | null;
  error: string | null;
  raw: string | null;
}

/** Read + parse JSON; reports malformed files instead of throwing. */
export async function readJsonSafe<T = unknown>(p: string): Promise<JsonRead<T>> {
  const raw = await readTextSafe(p);
  if (raw === null) return { data: null, error: null, raw: null };
  try {
    return { data: JSON.parse(raw) as T, error: null, raw };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e), raw };
  }
}

/** Walk from `from` (file or dir) up to and including `stop`. Nearest first. */
export function walkUp(from: string, stop: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(from);
  const top = path.resolve(stop);
  for (;;) {
    out.push(cur);
    if (cur === top) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // fs root
    // Stop if we walked past `stop` (cwd outside project).
    if (!cur.startsWith(top) && cur !== top) break;
    cur = parent;
  }
  return out;
}

/** Ancestor dirs from fs-root down to `dir` (for root-first ordering). */
export function ancestorsRootFirst(dir: string): string[] {
  const chain: string[] = [];
  let cur = path.resolve(dir);
  for (;;) {
    chain.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return chain.reverse();
}

/** Find git root by looking for `.git`; null when none. */
export async function findGitRoot(from: string): Promise<string | null> {
  let cur = path.resolve(from);
  for (;;) {
    if (await exists(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** List SKILL.md files one level under each base dir. Follows symlinked dirs. */
export async function findSkillFiles(bases: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const base of bases) {
    let entries;
    try {
      entries = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue;
      const skillFile = path.join(base, e.name, "SKILL.md");
      if (await isFile(skillFile)) out.push(skillFile);
    }
  }
  return out.sort();
}

/** List .md agent files directly inside dirs. */
export async function findAgentFiles(dirs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      if (e.name.toLowerCase().endsWith(".md")) out.push(path.join(dir, e.name));
    }
  }
  return out.sort();
}

/** Recursively list markdown files under dir (bounded depth, cycle-safe). */
export async function findMarkdownRecursive(dir: string, maxDepth = 4): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let real: string;
    try {
      real = await fs.realpath(d);
    } catch {
      real = path.resolve(d);
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() || e.isSymbolicLink()) {
        if (e.name.toLowerCase().endsWith(".md")) {
          if (await isFile(full)) out.push(full);
        } else if (e.isSymbolicLink() && (await isDir(full))) {
          await walk(full, depth + 1);
        }
      } else if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        await walk(full, depth + 1);
      }
    }
  }
  await walk(dir, 0);
  return out.sort();
}

/** Display path: `~` for home, relative for cwd, else absolute. */
export function displayPath(abs: string, cwd: string, home: string): string {
  if (abs === home || abs.startsWith(home + path.sep)) {
    return "~" + abs.slice(home.length);
  }
  const rel = path.relative(cwd, abs);
  if (rel === "") return ".";
  if (!rel.startsWith("..")) return rel;
  return abs;
}
