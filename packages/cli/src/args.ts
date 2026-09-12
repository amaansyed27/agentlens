/** Minimal argv parser — no dependencies. */
export interface GlobalFlags {
  json: boolean;
  agent?: string;
  cwd: string;
  noColor: boolean;
  help: boolean;
  version: boolean;
  max?: number;
}

export function parseArgs(argv: string[]): { command: string; positional: string[]; flags: GlobalFlags } {
  const positional: string[] = [];
  const flags: GlobalFlags = {
    json: false,
    cwd: process.cwd(),
    noColor: Boolean(process.env.NO_COLOR),
    help: false,
    version: false,
  };
  let command = "scan";
  const cmds = new Set(["scan", "tree", "tokens", "conflicts", "duplicates", "explain", "diff"]);
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--no-color") flags.noColor = true;
    else if (a === "--help" || a === "-h") flags.help = true;
    else if (a === "--version" || a === "-V") flags.version = true;
    else if (a === "--agent" || a === "--agentId") {
      flags.agent = argv[++i];
    } else if (a.startsWith("--agent=")) {
      flags.agent = a.slice("--agent=".length);
    } else if (a === "--cwd") {
      flags.cwd = argv[++i];
    } else if (a.startsWith("--cwd=")) {
      flags.cwd = a.slice("--cwd=".length);
    } else if (a === "--max") {
      flags.max = Number(argv[++i]);
    } else if (a.startsWith("--max=")) {
      flags.max = Number(a.slice("--max=".length));
    } else if (!a.startsWith("-") && cmds.has(a) && positional.length === 0 && command === "scan") {
      command = a;
    } else if (!a.startsWith("-")) {
      positional.push(a);
    } else {
      throw new Error(`unknown flag: ${a}`);
    }
    i++;
  }
  return { command, positional, flags };
}
