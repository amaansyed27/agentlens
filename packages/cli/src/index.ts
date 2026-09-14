#!/usr/bin/env node
/** Instrace CLI — thin rendering over instrace-core. */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  compareAgents,
  explainPath,
  resolveAgent,
  scanProject,
  listAdapters,
} from "instrace-core";
import { parseArgs } from "./args.js";
import { fmt, makeStyler, pad, plural } from "./format.js";

/** Package version, read from our own package.json (always shipped in the tarball). */
import { readFileSync } from "node:fs";

function cliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

const HELP = `Instrace — DevTools for your coding agent's context.

Usage:
  instrace [command] [options]

Commands:
  scan                  Overview of detected agents, sources, tokens, warnings
  tree [--agent <id>]   Show where each piece of context comes from
  tokens [--max <n>]    Token estimates + largest sources (exit 2 if over --max)
  conflicts             Deterministic instruction conflicts
  duplicates            Duplicated / highly-similar instruction blocks
  explain <path>        Why the agent sees each instruction for <path>
  diff <a> <b>          Why two agents behave differently in the same repo

Options:
  --agent <id>   opencode | codex | claude (most commands)
  --cwd <dir>    Directory to scan (default: cwd)
  --json         Stable JSON output for CI (stdout only; errors go to stderr)
  --max <n>      (tokens) fail with exit 2 when total exceeds n
  --no-color     Disable colors
  --version      Print version and exit
  --help         Show this help

Exit codes:
  0  successful analysis
  1  usage error or analysis failure (bad path, unknown agent, …)
  2  policy/budget threshold exceeded (tokens --max)
`;

function homeDir(): string | undefined {
  return process.env.INSTRACE_HOME;
}

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`instrace: ${e instanceof Error ? e.message : e}`);
    console.error(`Run "instrace --help" for usage.`);
    return 1;
  }
  const { command, positional, flags } = parsed;
  const st = makeStyler(flags.noColor);

  if (flags.help) {
    console.log(HELP);
    return 0;
  }
  if (flags.version) {
    console.log(cliVersion());
    return 0;
  }

  // Every command needs a real directory. Fail fast with a useful message
  // instead of reporting only global config for a typo'd path.
  const cwd = await resolveCwd(command, flags.cwd);
  if (cwd === null) return 1;
  flags.cwd = cwd;

  try {
    switch (command) {
      case "scan": return await cmdScan(flags, st);
      case "tree": return await cmdTree(flags, st);
      case "tokens": return await cmdTokens(flags, st);
      case "conflicts": return await cmdConflicts(flags, st);
      case "duplicates": return await cmdDuplicates(flags, st);
      case "explain": {
        if (!positional[0]) {
          console.error("instrace explain <path>  (missing path)");
          console.error(`Run "instrace --help" for usage.`);
          return 1;
        }
        return await cmdExplain(positional[0], flags, st);
      }
      case "diff": {
        if (!positional[0] || !positional[1]) {
          console.error("instrace diff <agent-a> <agent-b>  (expected two agent ids)");
          console.error(`Run "instrace --help" for usage.`);
          return 1;
        }
        return await cmdDiff(positional[0], positional[1], flags, st);
      }
      default:
        console.error(`unknown command: ${command}`);
        return 2;
    }
  } catch (e) {
    console.error(`instrace: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function emitJson(command: string, data: unknown): void {
  // Machine-readable envelope. stdout carries ONLY this document;
  // human diagnostics always go to stderr so parsers never break.
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        instraceVersion: cliVersion(),
        command,
        data,
      },
      null,
      2,
    ),
  );
}

/** Validate --cwd. Returns the resolved dir, or null after printing an error. */
async function resolveCwd(command: string, cwd: string): Promise<string | null> {
  const abs = path.resolve(cwd);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    stat = null;
  }
  if (!stat) {
    console.error(`Instrace could not run "${command}".`);
    console.error(``);
    console.error(`Directory does not exist:`);
    console.error(abs);
    return null;
  }
  if (!stat.isDirectory()) {
    console.error(`Instrace could not run "${command}".`);
    console.error(``);
    console.error(`Not a directory:`);
    console.error(abs);
    return null;
  }
  return abs;
}

// --- scan -----------------------------------------------------------------

async function cmdScan(flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const report = await scanProject({ cwd: flags.cwd, agent: flags.agent, homeDir: homeDir() });
  if (flags.json) {
    emitJson("scan", report);
    return 0;
  }
  console.log("");
  console.log(st.bold("Instrace"));
  console.log("");
  console.log(st.bold("Detected agents"));
  const anyDetected = report.agents.some((a) => a.detected);
  if (!anyDetected) {
    console.log(st.dim("  none — no agent markers found (use --agent to force one)"));
  }
  for (const a of report.agents) {
    if (!a.detected && flags.agent === undefined) continue;
    const mark = a.detected ? st.ok("✓") : st.dim("-");
    console.log(`  ${mark} ${label(a.agentId)}`);
  }
  console.log("");
  console.log(st.bold("Context sources"));
  const shown = report.agents.filter((a) => flags.agent !== undefined || a.detected);
  const multi = shown.length > 1;
  for (const a of shown) {
    if (multi) console.log(st.dim(`  ${a.agentId}`));
    for (const s of a.loaded) {
      console.log(`  ${multi ? " " : ""}${shortPath(s.path ?? s.label, flags.cwd)}${s.unverified ? st.dim("  [unverified]") : ""}`);
    }
  }
  const skillCount = countKind(report, "skill");
  const mcpCount = countKind(report, "mcp");
  if (skillCount > 0) console.log(`  ${skillCount} ${plural(skillCount, "skill", "skills")}`);
  if (mcpCount > 0) console.log(`  ${mcpCount} MCP ${plural(mcpCount, "server", "servers")}`);
  console.log("");
  console.log(st.bold("Estimated context"));
  const b = sumBreakdown(report);
  console.log(`  Instructions       ${fmt(b.instructions)} tokens`);
  console.log(`  Skills             ${fmt(b.skills)} tokens`);
  console.log(`  Tool definitions   ${fmt(b.tools)} tokens`);
  console.log(`  Other              ${fmt(b.other)} tokens`);
  console.log("");
  console.log(`  ${st.bold("Total")}               ${st.bold(`${fmt(b.total)} tokens`)}`);
  console.log("");
  const warnings = collectWarnings(report);
  if (warnings.length > 0) {
    console.log(st.bold("Warnings"));
    for (const w of warnings.slice(0, 10)) console.log(`  ${st.warn("⚠")} ${w}`);
    console.log("");
  }
  return 0;
}

// --- tree -----------------------------------------------------------------

async function cmdTree(flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const ids = flags.agent ? [flags.agent] : listAdapters().map((a) => a.id);
  const out: Record<string, unknown> = {};
  for (const id of ids) {
    const ec = await resolveAgent(flags.cwd, id, homeDir());
    if (flags.json) {
      out[id] = ec;
      continue;
    }
    console.log("");
    console.log(st.bold(label(id)));
    printTree(ec, flags.cwd, st);
  }
  if (flags.json) emitJson("tree", { version: 1, cwd: path.resolve(flags.cwd), agents: out });
  return 0;
}

function printTree(
  ec: { loaded: import("instrace-core").EffectiveContext["loaded"]; notLoaded: import("instrace-core").EffectiveContext["notLoaded"] },
  cwd: string,
  st: ReturnType<typeof makeStyler>,
): void {
  const groups = new Map<string, typeof ec.loaded>();
  for (const s of ec.loaded) {
    const g = groupName(s.kind);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  const order = ["Global", "Project", "Instructions", "Directory", "Dynamic", "Skills", "Agents", "MCP", "Other"];
  const names = [...groups.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  names.forEach((g, gi) => {
    const last = gi === names.length - 1;
    console.log(`${last ? "└─" : "├─"} ${g}`);
    const items = groups.get(g)!;
    items.forEach((s, si) => {
      const itemLast = si === items.length - 1;
      const bar = last ? "   " : "│  ";
      const fork = itemLast ? "└─" : "├─";
      const flag = s.unverified ? st.dim(" [unverified]") : "";
      const dyn = !s.alwaysLoaded ? st.dim(" (on demand)") : "";
      console.log(`${bar}${fork} ${shortPath(s.path ?? s.label, cwd)}${flag}${dyn}`);
      if (s.detail && !s.detail.startsWith("unverified")) console.log(`${bar}   ${st.dim(s.detail)}`);
    });
    if (!last) console.log("│");
  });
  const dyn = ec.notLoaded.filter((s) => s.exists);
  if (dyn.length > 0) {
    console.log("└─ Not loaded at startup");
    dyn.slice(0, 12).forEach((s, i) => {
      const last = i === Math.min(dyn.length, 12) - 1;
      console.log(`   ${last ? "└─" : "├─"} ${shortPath(s.path ?? s.label, cwd)}${st.dim(` — ${s.reason}`)}`);
    });
  }
  console.log("");
}

function groupName(kind: string): string {
  switch (kind) {
    case "global": return "Global";
    case "project": return "Project";
    case "instruction": return "Instructions";
    case "directory": return "Directory";
    case "dynamic": return "Dynamic";
    case "skill": return "Skills";
    case "agent": return "Agents";
    case "mcp": return "MCP";
    default: return "Other";
  }
}

// --- tokens ---------------------------------------------------------------

async function cmdTokens(flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const report = await scanProject({ cwd: flags.cwd, agent: flags.agent, homeDir: homeDir() });
  const agents = flags.agent ? report.agents : report.agents.filter((a) => a.detected);
  const list = agents.length > 0 ? agents : report.agents;
  if (flags.json) {
    emitJson("tokens", {
      version: 1,
      cwd: report.cwd,
      agents: list.map((a) => ({ agentId: a.agentId, breakdown: a.breakdown })),
    });
    return overMax(list, flags) ? 2 : 0;
  }
  for (const a of list) {
    console.log("");
    console.log(st.bold(`Tokens — ${label(a.agentId)}`));
    console.log("");
    console.log(`  Always loaded          ${fmt(a.breakdown.alwaysLoaded)}`);
    console.log(`  Conditional             ${fmt(a.breakdown.conditional)}`);
    console.log(`  Tool definitions        ${fmt(a.breakdown.tools)}`);
    console.log(`  Skills                  ${fmt(a.breakdown.skills)}`);
    console.log("");
    console.log(`  ${st.bold("Total potential")}         ${st.bold(fmt(a.breakdown.total))}`);
    console.log("");
    console.log(st.bold("Largest context sources"));
    console.log("");
    const candidates = [...a.loaded, ...a.notLoaded.filter((s) => s.exists)];
    const top = candidates.sort((x, y) => y.tokens - x.tokens).slice(0, 8);
    top.forEach((s, i) => {
      const tag = s.alwaysLoaded ? "" : st.dim("  (on demand)");
      console.log(`  ${i + 1}. ${pad(shortPath(s.path ?? s.label, flags.cwd), 30)} ${fmt(s.tokens)}${tag}`);
    });
    console.log("");
  }
  return overMax(list, flags) ? 2 : 0;
}

function overMax(agents: { breakdown: { total: number } }[], flags: { max?: number }): boolean {
  if (flags.max === undefined || Number.isNaN(flags.max)) return false;
  return agents.some((a) => a.breakdown.total > flags.max!);
}

// --- conflicts ------------------------------------------------------------

async function cmdConflicts(flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const report = await scanProject({ cwd: flags.cwd, agent: flags.agent, homeDir: homeDir() });
  if (flags.json) {
    emitJson("conflicts", { version: 1, cwd: report.cwd, conflicts: report.conflicts });
    return 0;
  }
  console.log("");
  if (report.conflicts.length === 0) {
    console.log(st.ok("No instruction conflicts detected."));
    console.log("");
    return 0;
  }
  for (const c of report.conflicts.slice(0, 20)) {
    console.log(st.bold("Conflict detected"));
    console.log("");
    for (const s of c.sources) {
      console.log(shortPath(s.path, flags.cwd));
      console.log(`  "${s.value}"${s.line ? st.dim(`  (line ${s.line})`) : ""}`);
      console.log("");
    }
    console.log(`Severity: ${c.severity === "HIGH" ? st.warn(c.severity) : c.severity}   Confidence: ${c.confidence}`);
    console.log(st.dim(c.message));
    console.log("");
  }
  if (report.conflicts.length > 20) {
    console.log(st.dim(`… and ${report.conflicts.length - 20} more (see --json for the full list)`));
    console.log("");
  }
  return 0;
}

// --- duplicates -----------------------------------------------------------

async function cmdDuplicates(flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const report = await scanProject({ cwd: flags.cwd, agent: flags.agent, homeDir: homeDir() });
  if (flags.json) {
    emitJson("duplicates", { version: 1, cwd: report.cwd, duplicates: report.duplicates });
    return 0;
  }
  console.log("");
  if (report.duplicates.length === 0) {
    console.log(st.ok("No duplicated context detected."));
    console.log("");
    return 0;
  }
  const shown = report.duplicates.slice(0, 20);
  for (const d of shown) {
    console.log(st.bold("Duplicate context"));
    console.log("");
    console.log(`${shortPath(d.a.path, flags.cwd)}`);
    console.log(st.dim(`  lines ${d.a.start}-${d.a.end}`));
    console.log("");
    console.log(`${shortPath(d.b.path, flags.cwd)}`);
    console.log(st.dim(`  lines ${d.b.start}-${d.b.end}`));
    console.log("");
    console.log(`Similarity: ${Math.round(d.similarity * 100)}%`);
    console.log("");
    console.log(`Potential saving: ~${fmt(d.tokensWasted)} tokens/request`);
    console.log("");
  }
  if (report.duplicates.length > shown.length) {
    console.log(st.dim(`… and ${report.duplicates.length - shown.length} more (see --json for the full list)`));
    console.log("");
  }
  return 0;
}

// --- explain --------------------------------------------------------------

async function cmdExplain(target: string, flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const agentId = flags.agent ?? "opencode";
  const rep = await explainPath({ cwd: flags.cwd, agent: agentId, target, homeDir: homeDir() });
  if (flags.json) {
    emitJson("explain", rep);
    return 0;
  }
  console.log("");
  console.log(st.bold("Effective context for:"));
  console.log(target);
  console.log(st.dim(`agent: ${agentId}`));
  try {
    await fs.stat(path.resolve(flags.cwd, target));
  } catch {
    console.log(st.dim("(target does not exist — showing scope resolution only)"));
  }
  console.log("");
  console.log(st.bold("Loaded:"));
  console.log("");
  rep.loaded.forEach((s, i) => {
    console.log(`${i + 1}. ${shortPath(s.path, flags.cwd)}`);
    console.log(st.dim(`   reason: ${s.reason}`));
    console.log("");
  });
  if (rep.notLoaded.length > 0) {
    console.log(st.bold("Not loaded:"));
    console.log("");
    for (const s of rep.notLoaded) {
      console.log(shortPath(s.path, flags.cwd));
      console.log(st.dim(`   reason: ${s.reason}`));
      console.log("");
    }
  }
  return 0;
}

// --- diff -----------------------------------------------------------------

async function cmdDiff(a: string, b: string, flags: ReturnType<typeof parseArgs>["flags"], st: ReturnType<typeof makeStyler>): Promise<number> {
  const rep = await compareAgents({ cwd: flags.cwd, left: a, right: b, homeDir: homeDir() });
  if (flags.json) {
    emitJson("diff", rep);
    return 0;
  }
  const w = Math.max(12, ...rep.rows.map((r) => r.label.length));
  console.log("");
  console.log(`${pad("", w)}  ${pad(a, 12)}  ${b}`);
  console.log("");
  for (const r of rep.rows) {
    const l = r.left ? st.ok("✓") : st.dim("-");
    const rr = r.right ? st.ok("✓") : st.dim("-");
    console.log(`${pad(r.label, w)}  ${pad(l, 12)}  ${rr}`);
  }
  console.log("");
  console.log(st.bold("Estimated context"));
  console.log(`${a}              ${fmt(rep.tokens.left)} tokens`);
  console.log(`${b}                 ${fmt(rep.tokens.right)} tokens`);
  console.log("");
  if (rep.differences.length > 0) {
    console.log(st.bold("Behaviour differences"));
    console.log("");
    for (const d of rep.differences) {
      const sev = d.severity === "HIGH" ? st.warn(d.severity) : d.severity;
      console.log(`${sev}`);
      console.log(`${d.message}`);
      console.log("");
    }
  }
  return 0;
}

// --- helpers --------------------------------------------------------------

function label(id: string): string {
  const found = listAdapters().find((a) => a.id === id);
  return found ? found.label : id;
}

function shortPath(abs: string, cwd: string): string {
  const home = process.env.INSTRACE_HOME ?? process.env.HOME ?? "";
  if (home && (abs === home || abs.startsWith(home + "/") || abs.startsWith(home + "\\"))) {
    return "~" + abs.slice(home.length).replace(/\\/g, "/");
  }
  const rel = path.relative(path.resolve(cwd), path.resolve(abs));
  if (rel === "") return ".";
  if (!rel.startsWith("..")) return rel.split(path.sep).join("/");
  return abs;
}

function countKind(report: Awaited<ReturnType<typeof scanProject>>, kind: string): number {
  const seen = new Set<string>();
  for (const a of report.agents) {
    for (const s of [...a.loaded, ...a.notLoaded]) {
      if (s.kind === kind && s.exists) seen.add(s.path ?? s.id);
    }
  }
  return seen.size;
}

function sumBreakdown(report: Awaited<ReturnType<typeof scanProject>>) {
  const b = { instructions: 0, skills: 0, tools: 0, other: 0, total: 0 };
  const agents = report.agents.filter((a) => a.detected);
  const list = agents.length > 0 ? agents : report.agents.slice(0, 1);
  for (const a of list) {
    // For the default overview, show the max-context agent to avoid double counting.
  }
  const richest = [...list].sort((x, y) => y.breakdown.total - x.breakdown.total)[0];
  if (richest) {
    b.instructions = richest.breakdown.instructions;
    b.skills = richest.breakdown.skills;
    b.tools = richest.breakdown.tools;
    b.other = richest.breakdown.other;
    b.total = richest.breakdown.total;
  }
  return b;
}

function collectWarnings(report: Awaited<ReturnType<typeof scanProject>>): string[] {
  const out: string[] = [];
  for (const d of report.duplicates.slice(0, 3)) {
    out.push(`duplicated instruction detected (${base(d.a.path)} ↔ ${base(d.b.path)}, ${Math.round(d.similarity * 100)}% similar)`);
  }
  for (const c of report.conflicts.slice(0, 4)) {
    out.push(c.message);
  }
  for (const a of report.agents) {
    for (const w of a.warnings) out.push(w);
    if (a.breakdown.alwaysLoaded > 20000) {
      out.push(`large always-loaded context in ${a.agentId} (${fmt(a.breakdown.alwaysLoaded)} tokens)`);
    }
  }
  return [...new Set(out)];
}

function base(p: string): string {
  return p.split(/[/\\]/).pop() ?? p;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`instrace: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
