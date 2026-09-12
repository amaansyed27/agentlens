/**
 * Deterministic instruction-conflict detection.
 *
 * Each rule extracts a normalized value from a source text with conservative
 * regexes. A conflict is reported only when two sources yield different,
 * non-null values. Confidence is HIGH when both statements are explicit
 * imperatives, MEDIUM when inferred from mentions. We never claim semantic
 * certainty beyond the matched patterns.
 */
import type { ConflictFinding } from "./types.js";

export interface ConflictDoc {
  path: string;
  text: string;
}

interface Rule {
  name: string;
  severity: ConflictFinding["severity"];
  message: string;
  extract: (text: string) => { value: string; line: number } | null;
}

function firstMatchLine(text: string, re: RegExp): { value: string; line: number } | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) return { value: (m[1] ?? m[0]).trim().toLowerCase(), line: i + 1 };
  }
  return null;
}

const RULES: Rule[] = [
  {
    name: "package-manager",
    severity: "HIGH",
    message: "Package manager differs between instruction files",
    extract: (t) =>
      firstMatchLine(
        t,
        /\b(?:always\s+use|use|prefer|must\s+use|package\s+manager\s*[:\s]\s*)\s+(pnpm|npm|yarn|bun|deno)\b/i,
      ),
  },
  {
    name: "indentation",
    severity: "MEDIUM",
    message: "Indentation rule differs (tabs vs spaces)",
    extract: (t) => {
      const m =
        firstMatchLine(t, /\buse\s+(tabs)\b/i) ??
        firstMatchLine(t, /\b(tabs)\s+for\s+indentation\b/i) ??
        firstMatchLine(t, /\bno\s+tabs\b/i);
      if (m) {
        const v = /no/.test(m.value) ? "spaces" : m.value.includes("tab") ? "tabs" : m.value;
        return { value: v, line: m.line };
      }
      const sp = firstMatchLine(t, /\b(\d)-space\s+indent/i) ?? firstMatchLine(t, /\bindent(?:ation)?[:\s]+(\d)\s*spaces?/i);
      if (sp) return { value: `${sp.value}-space`, line: sp.line };
      const spaces = firstMatchLine(t, /\buse\s+(spaces)\b/i);
      if (spaces) return spaces;
      return null;
    },
  },
  {
    name: "semicolons",
    severity: "LOW",
    message: "Semicolon style differs",
    extract: (t) => {
      const noSemi = firstMatchLine(t, /\bno\s+semicolons?\b/i);
      if (noSemi) return { value: "no-semicolons", line: noSemi.line };
      const useSemi = firstMatchLine(t, /\b(use|always\s+use|require)\s+semicolons?\b/i);
      if (useSemi) return { value: "semicolons", line: useSemi.line };
      return null;
    },
  },
  {
    name: "quotes",
    severity: "LOW",
    message: "Quote style differs (single vs double)",
    extract: (t) =>
      firstMatchLine(t, /\b(single|double)\s+quotes?\b/i),
  },
  {
    name: "test-command",
    severity: "MEDIUM",
    message: "Test command differs between instruction files",
    extract: (t) =>
      firstMatchLine(
        t,
        /\b(?:run\s+tests?(?:\s+with)?|test\s+command|test\s*:\s*)(`?)(npm\s+test|pnpm\s+test|yarn\s+test|bun\s+test|vitest|jest|pytest|go\s+test|cargo\s+test)[^\n`]*\1/i,
      ),
  },
  {
    name: "build-command",
    severity: "MEDIUM",
    message: "Build command differs between instruction files",
    extract: (t) =>
      firstMatchLine(
        t,
        /\b(?:build(?:\s+with|\s+command)?|run\s+the\s+build)(?:\s*:\s*|\s+with\s+|\s+using\s+|\s+)(`?)(npm\s+run\s+build|pnpm\s+build|yarn\s+build|tsc|vite\s+build|next\s+build|make)[^\n`]*\1/i,
      ),
  },
  {
    name: "language",
    severity: "HIGH",
    message: "Language requirement differs (TypeScript vs JavaScript)",
    extract: (t) => {
      const ts = firstMatchLine(t, /\b(use|must\s+use|always\s+use|write\s+in)\s+typescript\b/i);
      if (ts) return { value: "typescript", line: ts.line };
      const js = firstMatchLine(t, /\b(use|must\s+use|always\s+use|write\s+in|plain)\s+javascript\b/i);
      if (js) return { value: "javascript", line: js.line };
      return null;
    },
  },
  {
    name: "formatter",
    severity: "LOW",
    message: "Formatter/linter differs",
    extract: (t) =>
      firstMatchLine(
        t,
        /\b(?:use|run|format\s+with|lint\s+with)\s+(prettier|eslint|biome|ruff|black)\b/i,
      ),
  },
  {
    name: "edit-restriction",
    severity: "HIGH",
    message: "File-edit restrictions contradict each other",
    extract: (t) => {
      const never = firstMatchLine(
        t,
        /\b(never|do\s+not|don't)\s+(edit|modify|touch)\s+([^\n]{0,60})/i,
      );
      if (never) return { value: `restricted:${never.value.slice(0, 60)}`, line: never.line };
      const free = firstMatchLine(t, /\b(you\s+may|feel\s+free\s+to|always)\s+(edit|modify|refactor)\b/i);
      if (free) return { value: "edit-freely", line: free.line };
      return null;
    },
  },
  {
    name: "framework",
    severity: "MEDIUM",
    message: "Framework requirement differs",
    extract: (t) =>
      firstMatchLine(
        t,
        /\b(?:use|must\s+use|built\s+with|requires?)\s+(react|vue|svelte|next\.js|nuxt|angular|solid)\b/i,
      ),
  },
];

export function findConflicts(docs: ConflictDoc[]): ConflictFinding[] {
  const out: ConflictFinding[] = [];
  for (const rule of RULES) {
    const hits = docs
      .map((d) => ({ path: d.path, hit: rule.extract(d.text) }))
      .filter((h) => h.hit !== null) as { path: string; hit: { value: string; line: number } }[];
    const values = new Map<string, typeof hits>();
    for (const h of hits) {
      const list = values.get(h.hit.value) ?? [];
      list.push(h);
      values.set(h.hit.value, list);
    }
    if (values.size >= 2) {
      out.push({
        rule: rule.name,
        severity: rule.severity,
        confidence: rule.severity === "HIGH" ? "HIGH" : "MEDIUM",
        sources: hits.map((h) => ({ path: h.path, value: h.hit.value, line: h.hit.line })),
        message: rule.message,
      });
    }
  }
  return out.sort((a, b) => rank(a.severity) - rank(b.severity));
}

function rank(s: ConflictFinding["severity"]): number {
  return s === "HIGH" ? 0 : s === "MEDIUM" ? 1 : 2;
}
