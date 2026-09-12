import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanProject,
  explainPath,
  compareAgents,
  resolveAgent,
} from "../packages/core/dist/index.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (...p: string[]) => path.join(root, "fixtures", ...p);
const HOME = fx("home");

before(() => {
  process.env.AGENTLENS_HOME = HOME;
});

describe("opencode adapter", () => {
  it("discovers global + project + agent + skill + mcp sources", async () => {
    const ec = await resolveAgent(fx("opencode", "basic"), "opencode", HOME);
    const all = [...ec.loaded, ...ec.notLoaded];
    const labels = all.map((s) => s.path ?? s.label).join("\n");
    assert.match(labels, /AGENTS\.md/);
    assert.ok(all.some((s) => s.kind === "agent"), "expected agent definition");
    assert.ok(ec.loaded.some((s) => s.kind === "mcp"), "expected mcp servers");
    assert.ok(all.some((s) => s.kind === "skill"), "expected skill");
    assert.ok(ec.breakdown.total > 0);
  });

  it("detects conflicts fixture contradictions", async () => {
    const report = await scanProject({ cwd: fx("opencode", "conflicts"), agent: "opencode", homeDir: HOME });
    const rules = report.conflicts.map((c) => c.rule);
    assert.ok(rules.includes("package-manager"), `got: ${rules}`);
  });

  it("explains nested scope for a deep target", async () => {
    const rep = await explainPath({
      cwd: fx("opencode", "nested"),
      agent: "opencode",
      target: "src/auth/login.ts",
      homeDir: HOME,
    });
    const paths = rep.loaded.map((l) => l.path).join("\n");
    assert.match(paths, /src.auth.AGENTS\.md|src\/auth\/AGENTS\.md/);
    assert.ok(rep.loaded.length >= 2);
  });

  it("flags malformed config as a warning, not a crash", async () => {
    const ec = await resolveAgent(fx("malformed"), "opencode", HOME);
    assert.ok(Array.isArray(ec.warnings));
  });
});

describe("codex adapter", () => {
  it("builds root-down chain for nested dirs", async () => {
    const ec = await resolveAgent(fx("codex", "nested", "services", "payments"), "codex", HOME);
    const labels = ec.loaded.map((s) => s.path ?? "").join("\n");
    assert.match(labels, /AGENTS\.md/);
    // nested file must come after root file (deeper wins => later in context)
    const idxRoot = labels.indexOf(fx("codex", "nested", "AGENTS.md"));
    const idxNested = labels.indexOf("payments");
    assert.ok(idxRoot !== -1 && idxNested !== -1 && idxRoot < idxNested);
  });

  it("truncates the huge fixture at the byte budget", async () => {
    const ec = await resolveAgent(fx("huge"), "codex", HOME);
    assert.ok(
      ec.warnings.some((w) => w.includes("project_doc_max_bytes")) ||
        ec.notLoaded.some((s) => s.reason.includes("budget")),
    );
  });
});

describe("claude adapter", () => {
  it("resolves @imports and path-scoped rules", async () => {
    const ec = await resolveAgent(fx("claude", "basic"), "claude", HOME);
    const labels = ec.loaded.map((s) => s.path ?? s.label).join("\n");
    assert.match(labels, /style\.md/); // @import resolved
    assert.ok(ec.loaded.some((s) => s.label.startsWith("rule:general")), "general rule always loaded");
    const scoped = ec.notLoaded.find((s) => s.label.includes("rule:auth"));
    assert.ok(scoped, "path-scoped auth rule must be conditional");
  });

  it("treats subdirectory CLAUDE.md as lazy", async () => {
    const ec = await resolveAgent(fx("claude", "basic"), "claude", HOME);
    const lazy = ec.notLoaded.find((s) => s.path?.endsWith(path.join("billing", "CLAUDE.md")));
    assert.ok(lazy, "nested billing CLAUDE.md should be dynamic/not-loaded at root");
  });

  it("does not natively load AGENTS.md", async () => {
    const ec = await resolveAgent(fx("opencode", "basic"), "claude", HOME);
    const entry = ec.notLoaded.find((s) => s.path?.endsWith("AGENTS.md"));
    assert.ok(entry);
    assert.match(entry.reason, /does not read AGENTS\.md natively/);
  });
});

describe("diff", () => {
  it("shows why opencode and codex differ", async () => {
    const rep = await compareAgents({ cwd: fx("opencode", "basic"), left: "opencode", right: "codex", homeDir: HOME });
    assert.ok(rep.rows.length > 0);
    assert.ok(rep.tokens.left !== rep.tokens.right || rep.differences.length > 0);
  });
});

describe("duplicates", () => {
  it("finds the duplicated skill block", async () => {
    const report = await scanProject({ cwd: fx("duplicates"), agent: "opencode", homeDir: HOME });
    assert.ok(report.duplicates.length >= 1);
    assert.ok(report.duplicates[0].similarity >= 0.8);
  });
});
