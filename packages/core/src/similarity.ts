/**
 * Local duplicate detection — no embeddings, no network.
 *
 * Method: normalize lines (trim, collapse whitespace, lowercase), drop blanks
 * and short lines, then compare sources with a sliding window of N lines using
 * Jaccard similarity over token multisets. Windows scoring >= 0.8 are merged
 * into maximal ranges and reported. Deterministic and fast.
 */
import { estimateTokens } from "./tokenizer.js";

export interface DocInput {
  path: string;
  text: string;
}

export interface DuplicateFinding {
  a: { path: string; start: number; end: number };
  b: { path: string; start: number; end: number };
  similarity: number;
  tokensWasted: number;
  excerpt: string;
}

const WINDOW = 6;
const THRESHOLD = 0.8;

export function normalizeLine(line: string): string {
  return line
    .replace(/[#>*`_~\-+]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

interface LineInfo {
  /** 1-based original line number. */
  n: number;
  norm: string;
  raw: string;
  tokens: string[];
}

function toLines(text: string): LineInfo[] {
  return text.split("\n").map((raw, i) => {
    const norm = normalizeLine(raw);
    return { n: i + 1, norm, raw, tokens: norm ? norm.split(" ") : [] };
  });
}

function windowSet(lines: LineInfo[], start: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = start; i < start + WINDOW && i < lines.length; i++) {
    for (const t of lines[i].tokens) m.set(t, (m.get(t) ?? 0) + 1);
  }
  return m;
}

function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  let union = 0;
  for (const [k, ca] of a) {
    const cb = b.get(k) ?? 0;
    inter += Math.min(ca, cb);
    union += Math.max(ca, cb);
  }
  for (const [k, cb] of b) {
    if (!a.has(k)) union += cb;
  }
  return union === 0 ? 0 : inter / union;
}

/** Significant = not blank and not trivially short after normalization. */
function significant(lines: LineInfo[], start: number): boolean {
  let count = 0;
  for (let i = start; i < start + WINDOW && i < lines.length; i++) {
    if (lines[i].norm.length >= 12) count++;
  }
  return count >= 3;
}

export function findDuplicates(docs: DocInput[]): DuplicateFinding[] {
  const parsed = docs
    .filter((d) => d.text.trim().length > 0)
    .map((d) => ({ path: d.path, text: d.text, lines: toLines(d.text) }));
  // Precompute per-doc window sets and vocabulary once (not per pair).
  const precomputed = parsed.map((doc) => {
    const windows: { set: Map<string, number>; sig: boolean }[] = [];
    const vocab = new Set<string>();
    if (doc.lines.length >= WINDOW) {
      for (let i = 0; i + WINDOW <= doc.lines.length; i++) {
        const sig = significant(doc.lines, i);
        const set = sig ? windowSet(doc.lines, i) : new Map<string, number>();
        windows.push({ set, sig });
        for (const t of set.keys()) vocab.add(t);
      }
    } else {
      for (const l of doc.lines) for (const t of l.tokens) vocab.add(t);
    }
    return { doc, windows, vocab };
  });
  const findings: DuplicateFinding[] = [];

  for (let x = 0; x < precomputed.length; x++) {
    for (let y = x + 1; y < precomputed.length; y++) {
      const A = precomputed[x];
      const B = precomputed[y];
      // Early skip: no shared vocabulary means no similar window.
      let overlap = false;
      const [small, big] = A.vocab.size < B.vocab.size ? [A.vocab, B.vocab] : [B.vocab, A.vocab];
      for (const t of small) {
        if (big.has(t)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) continue;
      const aLines = A.doc.lines;
      const bLines = B.doc.lines;
      if (aLines.length < WINDOW || bLines.length < WINDOW) {
        // Fall back to whole-doc comparison for short files.
        const whole = wholeDocSimilarity(aLines, bLines);
        if (whole >= THRESHOLD && A.doc.text.trim() !== "" && B.doc.text.trim() !== "") {
          findings.push({
            a: { path: A.doc.path, start: 1, end: aLines.length },
            b: { path: B.doc.path, start: 1, end: bLines.length },
            similarity: round2(whole),
            tokensWasted: Math.min(estimateTokens(A.doc.text), estimateTokens(B.doc.text)),
            excerpt: excerptFor(A.doc, 0, aLines.length),
          });
        }
        continue;
      }
      // For each window in B, find best window in A (sets precomputed above).
      let best = { sim: 0, ai: 0, bi: 0 };
      for (let bi = 0; bi < B.windows.length; bi++) {
        if (!B.windows[bi].sig) continue;
        const bs = B.windows[bi].set;
        for (let ai = 0; ai < A.windows.length; ai++) {
          if (A.windows[ai].set.size === 0) continue;
          const s = jaccard(A.windows[ai].set, bs);
          if (s > best.sim) best = { sim: s, ai, bi };
        }
      }
      if (best.sim >= THRESHOLD) {
        // Expand around the best window pair while lines stay similar.
        let aStart = best.ai;
        let bStart = best.bi;
        let aEnd = best.ai + WINDOW - 1;
        let bEnd = best.bi + WINDOW - 1;
        while (
          aStart > 0 &&
          bStart > 0 &&
          lineSim(aLines[aStart - 1], bLines[bStart - 1]) >= 0.5
        ) {
          aStart--;
          bStart--;
        }
        while (
          aEnd + 1 < aLines.length &&
          bEnd + 1 < bLines.length &&
          lineSim(aLines[aEnd + 1], bLines[bEnd + 1]) >= 0.5
        ) {
          aEnd++;
          bEnd++;
        }
        const dupText = aLines
          .slice(aStart, aEnd + 1)
          .map((l) => l.raw)
          .join("\n");
        findings.push({
          a: { path: A.doc.path, start: aLines[aStart].n, end: aLines[aEnd].n },
          b: { path: B.doc.path, start: bLines[bStart].n, end: bLines[bEnd].n },
          similarity: round2(best.sim),
          tokensWasted: estimateTokens(dupText),
          excerpt: excerptFor(A.doc, aStart, aEnd + 1),
        });
      }
    }
  }
  return findings.sort((p, q) => q.similarity - p.similarity);
}

function lineSim(a: LineInfo, b: LineInfo): number {
  if (!a.norm || !b.norm) return 0;
  const sa = new Set(a.norm.split(" "));
  const sb = new Set(b.norm.split(" "));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

function wholeDocSimilarity(a: LineInfo[], b: LineInfo[]): number {
  const ma = new Map<string, number>();
  const mb = new Map<string, number>();
  for (const l of a) for (const t of l.tokens) ma.set(t, (ma.get(t) ?? 0) + 1);
  for (const l of b) for (const t of l.tokens) mb.set(t, (mb.get(t) ?? 0) + 1);
  return jaccard(ma, mb);
}

function excerptFor(doc: { lines: LineInfo[] }, start: number, end: number): string {
  return doc.lines
    .slice(start, Math.min(end, start + 4))
    .map((l) => l.raw.trim())
    .filter(Boolean)
    .join(" / ")
    .slice(0, 160);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
