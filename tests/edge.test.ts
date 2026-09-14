import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanProject, resolveAgent, explainPath } from "@agentlens/core";

let dir = "";
const HOME = path.join(os.tmpdir(), "agentlens-no-such-home");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agentlens-edge-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string | Buffer): Promise<string> {
  const full = path.join(dir, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

describe("edge cases", () => {
  it("strips BOM and handles CRLF", async () => {
    const BOM = String.fromCharCode(0xfeff);
    // BOM before frontmatter must not break `paths:` scoping detection.
    await write(
      ".claude/rules/scoped.md",
      `${BOM}---\npaths:\n  - src/auth/**\n---\n\n# Scoped rule\n\nAuth code must use the session helper.\n`,
    );
    await write("AGENTS.md", "# Root\n\nAlways use pnpm.\n");
    const ec = await resolveAgent(dir, "claude", HOME);
    const scoped = ec.notLoaded.find((s) => s.label.includes("rule:scoped"));
    assert.ok(scoped, "BOM-prefixed path-scoped rule must still be conditional");
  });

  it("survives invalid UTF-8 bytes", async () => {
    await write("AGENTS.md", Buffer.from([0x41, 0x47, 0x45, 0xff, 0xfe, 0x4e, 0x54, 0x53]));
    const report = await scanProject({ cwd: dir, homeDir: HOME });
    assert.ok(report.agents.length === 3);
  });

  it("handles empty instruction files", async () => {
    await write("AGENTS.md", "   \n");
    const ec = await resolveAgent(dir, "codex", HOME);
    // Codex skips empty files: no project AGENTS.md in loaded.
    assert.ok(!ec.loaded.some((s) => s.path === path.join(dir, "AGENTS.md")));
  });

  it("works when HOME config is absent", async () => {
    await write("AGENTS.md", "Always use pnpm.");
    const ec = await resolveAgent(dir, "opencode", path.join(dir, "no-home-here"));
    assert.ok(ec.loaded.some((s) => s.path === path.join(dir, "AGENTS.md")));
    assert.ok(ec.notLoaded.some((s) => s.kind === "global" && !s.exists));
  });

  it("handles spaces and unicode in paths", async () => {
    const sub = path.join("my project", "ünïcode dir");
    await write(path.join(sub, "AGENTS.md"), "Always use pnpm for package management.");
    const rep = await explainPath({ cwd: dir, agent: "opencode", target: path.join(sub, "x.ts"), homeDir: HOME });
    assert.ok(
      rep.loaded.some((l) => l.path === path.join(dir, sub, "AGENTS.md")),
      JSON.stringify(rep.loaded.map((l) => l.path)),
    );
  });

  it("ignores lookalike filenames", async () => {
    await write("AGENTS.md.bak", "Always use npm.");
    await write("AGENTS.md", "Always use pnpm.");
    const report = await scanProject({ cwd: dir, agent: "codex", homeDir: HOME });
    assert.ok(!report.conflicts.some((c) => c.rule === "package-manager"));
  });

  it("tolerates malformed rule frontmatter", async () => {
    await write(".claude/rules/broken.md", "---\npaths: [unclosed\n\n# Rule\n\nAlways use pnpm.");
    const ec = await resolveAgent(dir, "claude", HOME);
    assert.ok(ec.loaded.some((s) => s.label.includes("broken")));
  });

  it("resolves 20-level nesting", async () => {
    await write(".git/HEAD", "ref: refs/heads/main\n");
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join("/");
    await write(`${deep}/AGENTS.md`, "Deep rule: always use pnpm.");
    await write("AGENTS.md", "Root rule.");
    // Codex builds root -> cwd: run from the deep directory like a real session.
    const rep = await explainPath({ cwd: path.join(dir, deep), agent: "codex", target: "f.ts", homeDir: HOME });
    assert.ok(rep.loaded.some((l) => l.path === path.join(dir, deep, "AGENTS.md")));
    assert.ok(rep.loaded.some((l) => l.path === path.join(dir, "AGENTS.md")));
  });

  it("broken symlinks and cycles do not hang or crash", async () => {
    try {
      await write("real/AGENTS.md", "Always use pnpm.");
      await fs.symlink(
        path.join(dir, "no-such-target"),
        path.join(dir, "real", "broken.md"),
      ).catch(() => {});
      await fs.symlink(dir, path.join(dir, "real", "loop")).catch(() => {});
    } catch {
      return; // symlink privileges unavailable — skip
    }
    const report = await scanProject({ cwd: dir, agent: "opencode", homeDir: HOME });
    assert.ok(report.agents.length > 0);
  });

  it("reads symlinked copies of one file once", async () => {
    const body = "# Shared\n\nAlways use pnpm for everything.\nUse TypeScript always.\nRun tests first.\nBuild second.\nLint third.\nDocument fourth.\n";
    try {
      await write("shared/SKILL.md", body);
      await fs.mkdir(path.join(dir, "skills"), { recursive: true });
      for (const name of ["a", "b"]) {
        try {
          await fs.symlink(path.join(dir, "shared"), path.join(dir, "skills", name), "junction");
        } catch {
          await fs.symlink(path.join(dir, "shared"), path.join(dir, "skills", name));
        }
      }
    } catch {
      return; // symlink privileges unavailable — skip
    }
    const report = await scanProject({ cwd: dir, agent: "opencode", homeDir: HOME });
    for (const d of report.duplicates) {
      const { realpath } = await import("node:fs/promises").catch(() => ({ realpath: null }));
      if (realpath) {
        const a = await realpath(d.a.path).catch(() => d.a.path);
        const b = await realpath(d.b.path).catch(() => d.b.path);
        assert.notEqual(a, b, "self-duplicate via symlink");
      }
    }
  });
});
