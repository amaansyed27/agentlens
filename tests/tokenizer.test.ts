import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, describeText } from "@agentlens/core";

describe("tokenizer", () => {
  it("estimates ~4 chars per token", () => {
    assert.equal(estimateTokens("a".repeat(400)), 100);
  });
  it("returns 0 for empty text", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("   \n  "), 0);
  });
  it("describes text stats", () => {
    const s = describeText("hello world\nsecond line");
    assert.equal(s.lines, 2);
    assert.equal(s.words, 4);
    assert.ok(s.tokens > 0);
  });
});
