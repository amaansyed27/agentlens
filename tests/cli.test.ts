import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(root, "packages", "cli", "dist", "index.js");
const fx = (...p: string[]) => path.join(root, "fixtures", ...p);

function cli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, AGENTLENS_HOME: fx("home"), NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        resolve({ stdout: String(stdout), stderr: String(stderr), code: (err as { code?: number })?.code ?? 0 });
      },
    );
  });
}

describe("cli smoke", () => {
  before(async () => {
    // ensure built CLI exists
    const fs = await import("node:fs");
    assert.ok(fs.existsSync(CLI), "CLI dist missing — run npm run build first");
  });

  it("scan prints agents and tokens", async () => {
    const r = await cli(["scan"], fx("opencode", "basic"));
    assert.equal(r.code, 0);
    assert.match(r.stdout, /AgentLens/);
    assert.match(r.stdout, /Total/);
  });

  it("scan --json is a versioned envelope on stdout only", async () => {
    const r = await cli(["scan", "--json"], fx("opencode", "basic"));
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    const j = JSON.parse(r.stdout);
    assert.equal(j.schemaVersion, 1);
    assert.equal(j.command, "scan");
    assert.match(j.agentlensVersion, /^\d+\.\d+\.\d+/);
    assert.equal(j.data.version, 1);
    assert.ok(Array.isArray(j.data.agents));
  });

  it("every command emits the envelope with its own name", async () => {
    const cases: [string[], string][] = [
      [["tree", "--json"], "tree"],
      [["tokens", "--json"], "tokens"],
      [["conflicts", "--json"], "conflicts"],
      [["duplicates", "--json"], "duplicates"],
      [["explain", "--json", "AGENTS.md"], "explain"],
      [["diff", "--json", "opencode", "codex"], "diff"],
    ];
    for (const [args, name] of cases) {
      const r = await cli(args, fx("opencode", "basic"));
      assert.equal(r.code, 0, `${args.join(" ")} failed: ${r.stderr}`);
      const j = JSON.parse(r.stdout);
      assert.equal(j.schemaVersion, 1, args.join(" "));
      assert.equal(j.command, name, args.join(" "));
      assert.ok(j.data, args.join(" "));
    }
  });

  it("tree / tokens / conflicts / duplicates / explain / diff run", async () => {
    for (const args of [
      ["tree"],
      ["tokens"],
      ["conflicts"],
      ["duplicates"],
      ["explain", "AGENTS.md"],
      ["diff", "opencode", "codex"],
    ]) {
      const r = await cli(args, fx("opencode", "basic"));
      assert.equal(r.code, 0, `${args.join(" ")} failed: ${r.stderr}`);
    }
  });

  it("tokens --max exits 2 when over budget", async () => {
    const r = await cli(["tokens", "--max", "1"], fx("opencode", "basic"));
    assert.equal(r.code, 2);
  });

  it("--help works", async () => {
    const r = await cli(["--help"], fx("empty"));
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage/);
    assert.match(r.stdout, /Exit codes/);
  });

  it("--version prints the package version", async () => {
    const r = await cli(["--version"], fx("empty"));
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+/);
  });

  it("nonexistent cwd fails with exit 1 and a useful error", async () => {
    const r = await cli(["scan", "--cwd", fx("does-not-exist")], fx("empty"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not run "scan"/);
    assert.match(r.stderr, /does not exist/);
  });

  it("cwd pointing to a file fails with exit 1", async () => {
    const r = await cli(["scan", "--cwd", fx("opencode", "basic", "AGENTS.md")], fx("empty"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Not a directory/);
  });

  it("unknown agent fails with exit 1 and lists valid ids", async () => {
    const r = await cli(["scan", "--agent", "cursor"], fx("empty"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown agent: cursor/);
    assert.match(r.stderr, /opencode/);
  });

  it("unknown flag fails with exit 1", async () => {
    const r = await cli(["scan", "--frobnicate"], fx("empty"));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown flag/);
  });

  it("missing explain/diff args fail with exit 1", async () => {
    assert.equal((await cli(["explain"], fx("empty"))).code, 1);
    assert.equal((await cli(["diff", "opencode"], fx("empty"))).code, 1);
  });
});
