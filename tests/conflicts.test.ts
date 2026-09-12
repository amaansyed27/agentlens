import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findConflicts } from "../packages/core/dist/index.js";

describe("conflicts", () => {
  it("detects package-manager contradictions", () => {
    const out = findConflicts([
      { path: "AGENTS.md", text: "Always use pnpm for package management." },
      { path: "build.md", text: "Use npm for package management." },
    ]);
    const pm = out.find((c) => c.rule === "package-manager");
    assert.ok(pm);
    assert.equal(pm.severity, "HIGH");
    assert.equal(pm.confidence, "HIGH");
  });
  it("detects semicolon contradictions", () => {
    const out = findConflicts([
      { path: "a.md", text: "Always use semicolons." },
      { path: "b.md", text: "No semicolons." },
    ]);
    assert.ok(out.find((c) => c.rule === "semicolons"));
  });
  it("reports nothing when rules agree", () => {
    const out = findConflicts([
      { path: "a.md", text: "Always use pnpm." },
      { path: "b.md", text: "Always use pnpm for installs." },
    ]);
    assert.ok(!out.find((c) => c.rule === "package-manager"));
  });
  it("does not invent conflicts from empty docs", () => {
    assert.deepEqual(findConflicts([]), []);
  });
});
