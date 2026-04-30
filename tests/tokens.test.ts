import { describe, it, expect } from "vitest";
import { estimateTokens } from "../src/tokens.js";

/**
 * Token estimator tests. The estimator only needs order-of-magnitude
 * accuracy (DESIGN.md §11) so these tests assert ranges rather than exact
 * counts — strict equality would lock us out of swapping in the SDK
 * tokenizer when it becomes public.
 */

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ~4 chars/token for ASCII English", () => {
    const text = "The quick brown fox jumps over the lazy dog.";
    const est = estimateTokens(text);
    expect(est, "ASCII should be roughly len/4").toBeGreaterThanOrEqual(
      Math.floor(text.length / 5),
    );
    expect(est, "ASCII shouldn't blow up to len/2").toBeLessThanOrEqual(
      Math.ceil(text.length / 3),
    );
  });

  it("estimates ~1.5 chars/token for CJK (denser than ASCII)", () => {
    const text = "你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界";
    const est = estimateTokens(text);
    expect(
      est,
      "CJK should yield at least ~half-as-many-tokens-as-chars",
    ).toBeGreaterThanOrEqual(Math.floor(text.length / 2));
  });

  it("handles mixed-script prompts without crashing or returning NaN", () => {
    const text = "Refactor 这个 module 请 help: src/main.ts";
    const est = estimateTokens(text);
    expect(Number.isFinite(est), "result should be a finite number").toBe(true);
    expect(est, "mixed prompt should produce a positive estimate").toBeGreaterThan(0);
  });

  it("scales linearly with prompt size", () => {
    const small = estimateTokens("x".repeat(100));
    const big = estimateTokens("x".repeat(10_000));
    expect(big, "10K chars should produce ~100x more tokens than 100 chars").toBeGreaterThan(
      small * 90,
    );
    expect(big).toBeLessThan(small * 110);
  });
});
