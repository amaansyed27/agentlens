import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findDuplicates } from "../packages/core/dist/index.js";

const BLOCK = [
  "Use TypeScript for all new code.",
  "Use single quotes and semicolons.",
  "Run tests with pnpm test before committing.",
  "Build with pnpm build and verify output.",
  "Always use pnpm for package management.",
  "Never commit without running the linter first.",
].join("\n");

describe("similarity", () => {
  it("detects highly similar blocks", () => {
    const found = findDuplicates([
      { path: "a/AGENTS.md", text: `# Root\n\n${BLOCK}\n\nExtra line here.` },
      { path: "b/SKILL.md", text: `# Skill\n\n${BLOCK}\n\nDifferent tail.` },
    ]);
    assert.ok(found.length >= 1);
    assert.ok(found[0].similarity >= 0.8);
    assert.ok(found[0].tokensWasted > 0);
  });
  it("ignores unrelated files", () => {
    const found = findDuplicates([
      { path: "a.md", text: "Apples are red fruits that grow on trees in spring." },
      { path: "b.md", text: "Quantum databases replicate state across regions nightly." },
    ]);
    assert.equal(found.length, 0);
  });
});
