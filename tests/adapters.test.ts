import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  scanProject,
  explainPath,
  compareAgents,
  resolveAgent,
} from "@agentlens/core";
import { HOME, mkRepo } from "./helpers.js";

const tmp: string[] = [];
afterEach(async () => {
  while (tmp.length) {
    const d = tmp.pop() as string;
    await fs.rm(d, { recursive: true, force: true });
  }
});

before(() => {
  process.env.AGENTLENS_HOME = HOME;
});

async function repo(files: Record<string, string>): Promise<string> {
  const d = await mkRepo(files);
  tmp.push(d);
  return d;
}

const BASIC_OPENCODE = {
  "AGENTS.md":
    "# Test Project\n\nAlways use pnpm for package management. Never use npm.\n\nUse TypeScript for all new code.\n",
  ".opencode/agents/build.md":
    "# Build agent\n\nYou are the build specialist. Run tests before committing.\n",
  "opencode.json": JSON.stringify({
    instructions: ["docs/standards.md"],
    mcp: { github: { type: "remote" }, filesystem: { type: "local" } },
  }),
  "docs/standards.md": "# Standards\n\nUse 2-space indentation.\n",
  "skills/frontend/SKILL.md": "# Frontend Skill\n\nUse React for UI components.\n",
};

describe("opencode adapter", () => {
  it("discovers global + project + agent + skill + mcp sources", async () => {
    const dir = await repo(BASIC_OPENCODE);
    const ec = await resolveAgent(dir, "opencode", HOME);
    const all = [...ec.loaded, ...ec.notLoaded];
    const labels = all.map((s) => s.path ?? s.label).join("\n");
    assert.match(labels, /AGENTS\.md/);
    assert.ok(all.some((s) => s.kind === "agent"), "expected agent definition");
    assert.ok(ec.loaded.some((s) => s.kind === "mcp"), "expected mcp servers");
    assert.ok(all.some((s) => s.kind === "skill"), "expected skill");
    assert.ok(ec.breakdown.total > 0);
  });

  it("detects project contradictions", async () => {
    const dir = await repo({
      "AGENTS.md": "# Root rules\n\nAlways use pnpm for package management.\nUse tabs for indentation.\n",
      ".opencode/agents/build.md": "# Build agent rules\n\nUse npm for package management.\nUse spaces for indentation.\n",
    });
    const report = await scanProject({ cwd: dir, agent: "opencode", homeDir: HOME });
    const rules = report.conflicts.map((c) => c.rule);
    assert.ok(rules.includes("package-manager"), `got: ${rules}`);
  });

  it("explains nested scope for a deep target", async () => {
    const dir = await repo({
      "AGENTS.md": "# Root rules\n\nAlways use pnpm.\n",
      "src/auth/AGENTS.md": "# Auth area rules\n\nNever log raw tokens.\n",
      "src/auth/login.ts": "export function login() {}\n",
    });
    const rep = await explainPath({
      cwd: dir,
      agent: "opencode",
      target: "src/auth/login.ts",
      homeDir: HOME,
    });
    const paths = rep.loaded.map((l) => l.path).join("\n");
    assert.match(paths, /src.auth.AGENTS\.md|src\/auth\/AGENTS\.md/);
    assert.ok(rep.loaded.length >= 2);
  });

  it("flags malformed config as a warning, not a crash", async () => {
    const dir = await repo({ "opencode.json": "{ not valid json !!!" });
    const ec = await resolveAgent(dir, "opencode", HOME);
    assert.ok(Array.isArray(ec.warnings));
  });
});

describe("codex adapter", () => {
  it("builds root-down chain for nested dirs", async () => {
    const dir = await repo({
      "AGENTS.md": "# Codex project root\n\nAlways use pnpm.\n",
      "services/payments/AGENTS.md": "# Payments rules\n\nPayments code must use the idempotency helper.\n",
    });
    const ec = await resolveAgent(path.join(dir, "services", "payments"), "codex", HOME);
    const labels = ec.loaded.map((s) => s.path ?? "").join("\n");
    assert.match(labels, /AGENTS\.md/);
    // nested file must come after root file (deeper wins => later in context)
    const idxRoot = labels.indexOf(path.join(dir, "AGENTS.md"));
    const idxNested = labels.indexOf("payments");
    assert.ok(idxRoot !== -1 && idxNested !== -1 && idxRoot < idxNested);
  });

  it("truncates huge instructions at the byte budget", async () => {
    const dir = await repo({
      "AGENTS.md": `# Huge context\n\n${"Always follow the style guide. Prefer small modules.\n".repeat(2500)}`,
    });
    const ec = await resolveAgent(dir, "codex", HOME);
    assert.ok(
      ec.warnings.some((w) => w.includes("project_doc_max_bytes")) ||
        ec.notLoaded.some((s) => s.reason.includes("budget")),
    );
  });
});

describe("claude adapter", () => {
  const BASIC_CLAUDE = {
    "CLAUDE.md": "# Claude project\n\nUse TypeScript. Keep functions small.\n\n@./docs/style.md\n",
    "docs/style.md": "# Style guide\n\nUse single quotes.\n",
    ".claude/rules/auth.md": "---\npaths:\n  - src/auth/**\n---\n\n# Auth rule\n\nAuth code must use the session helper.\n",
    ".claude/rules/general.md": "# General rule\n\nAlways write tests for new code.\n",
    "src/billing/CLAUDE.md": "# Nested billing rules\n\nBilling code must use integer cents.\n",
  };

  it("resolves @imports and path-scoped rules", async () => {
    const dir = await repo(BASIC_CLAUDE);
    const ec = await resolveAgent(dir, "claude", HOME);
    const labels = ec.loaded.map((s) => s.path ?? s.label).join("\n");
    assert.match(labels, /style\.md/); // @import resolved
    assert.ok(ec.loaded.some((s) => s.label.startsWith("rule:general")), "general rule always loaded");
    const scoped = ec.notLoaded.find((s) => s.label.includes("rule:auth"));
    assert.ok(scoped, "path-scoped auth rule must be conditional");
  });

  it("treats subdirectory CLAUDE.md as lazy", async () => {
    const dir = await repo(BASIC_CLAUDE);
    const ec = await resolveAgent(dir, "claude", HOME);
    const lazy = ec.notLoaded.find((s) => s.path?.endsWith(path.join("billing", "CLAUDE.md")));
    assert.ok(lazy, "nested billing CLAUDE.md should be dynamic/not-loaded at root");
  });

  it("does not natively load AGENTS.md", async () => {
    const dir = await repo({ ...BASIC_OPENCODE });
    const ec = await resolveAgent(dir, "claude", HOME);
    const entry = ec.notLoaded.find((s) => s.path?.endsWith("AGENTS.md"));
    assert.ok(entry);
    assert.match(entry.reason, /does not read AGENTS\.md natively/);
  });
});

describe("diff", () => {
  it("shows why opencode and codex differ", async () => {
    const dir = await repo(BASIC_OPENCODE);
    const rep = await compareAgents({ cwd: dir, left: "opencode", right: "codex", homeDir: HOME });
    assert.ok(rep.rows.length > 0);
    assert.ok(rep.tokens.left !== rep.tokens.right || rep.differences.length > 0);
  });
});

describe("duplicates", () => {
  it("finds the duplicated skill block", async () => {
    const block = "Use TypeScript for all new code. Use single quotes and semicolons.\nRun tests with `pnpm test`. Build with `pnpm build`.\nAlways use pnpm for package management. Never use npm.\n";
    const dir = await repo({
      "AGENTS.md": `# Duplicate root\n\n${block}`,
      "skills/frontend/SKILL.md": `# Frontend skill\n\n${block}`,
    });
    const report = await scanProject({ cwd: dir, agent: "opencode", homeDir: HOME });
    assert.ok(report.duplicates.length >= 1);
    assert.ok(report.duplicates[0].similarity >= 0.8);
  });
});
