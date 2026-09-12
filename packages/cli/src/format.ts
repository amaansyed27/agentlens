/** Restrained terminal styling: symbols + spacing, color optional. */
export interface Styler {
  bold(s: string): string;
  dim(s: string): string;
  warn(s: string): string;
  ok(s: string): string;
  enabled: boolean;
}

export function makeStyler(noColor: boolean): Styler {
  const enabled = !noColor && process.stdout.isTTY !== false && !process.env.NO_COLOR;
  const wrap = (code: string) => (s: string) => (enabled ? `\u001b[${code}m${s}\u001b[0m` : s);
  return {
    enabled,
    bold: wrap("1"),
    dim: wrap("2"),
    warn: wrap("33"),
    ok: wrap("32"),
  };
}

export function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export function pad(s: string, width: number): string {
  if (s.length >= width) return s.slice(0, width);
  return s + " ".repeat(width - s.length);
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
