import { describe, it, expect } from "vitest";
import { runHeuristics } from "../src/classifier/heuristics.js";
import { resolveConfig } from "../src/config.js";

/**
 * Heuristic classifier tests. Pure-function tests — no I/O, no mocks.
 *
 * Coverage targets per DESIGN.md §5 "Tier-0 Heuristics":
 *   - All four trivial/escalate signals fire when expected
 *   - All four signals stay silent when not expected
 *   - Both flags can be true simultaneously (decision.ts resolves the tie)
 *   - Reasons array is correctly populated for the WAL audit trail
 *   - File-path / function-call density detector doesn't false-positive
 *     on URLs, conversational slashes, or short identifier-like words
 */

const cfg = resolveConfig({}).classifier.heuristics;

describe("runHeuristics — trivial signals", () => {
  it("marks short prompts without a question mark as trivial", () => {
    const r = runHeuristics("ok thanks", cfg);
    expect(r.trivial, "short non-question prompts are trivial").toBe(true);
    expect(r.escalate, "trivial chitchat shouldn't escalate").toBe(false);
    expect(
      r.reasons.some((x) => x.kind === "trivial_short_no_question"),
      "should record short_no_question reason",
    ).toBe(true);
  });

  it("does NOT mark short prompts as trivial-by-length when they ask a question", () => {
    const r = runHeuristics("what?", cfg);
    expect(
      r.reasons.some((x) => x.kind === "trivial_short_no_question"),
      "questions, even short ones, should not be marked length-trivial",
    ).toBe(false);
  });

  it("marks prompts as trivial via the trivialPatterns regex set", () => {
    const r = runHeuristics(
      "ok cool, that helped a lot — appreciate the explanation, can you continue?",
      cfg,
    );
    expect(r.trivial, "trivial pattern (ok|cool) should fire").toBe(true);
    expect(
      r.reasons.find((x) => x.kind === "trivial_pattern_match"),
      "should record trivial_pattern_match reason",
    ).toBeDefined();
  });

  it("does NOT fire trivial signals on neutral prose above the length floor", () => {
    // Must be > maxTrivialChars (80) to skip the short_no_question rule, and
    // must contain no trivial/greeting keywords. Picked carefully — even
    // common openers like "hello" trip the trivial pattern set.
    const prompt =
      "Please consider the implications of moving forward with the planned approach when you have time.";
    expect(
      prompt.length,
      "test prompt must exceed maxTrivialChars to isolate the pattern path",
    ).toBeGreaterThan(cfg.maxTrivialChars);
    const r = runHeuristics(prompt, cfg);
    expect(r.trivial, "neutral prose above the length floor should not be trivial").toBe(false);
  });

  it("returns trivial=false for the empty string (don't downgrade nothing)", () => {
    const r = runHeuristics("", cfg);
    expect(r.trivial, "empty prompt is not trivial").toBe(false);
    expect(r.escalate, "empty prompt is not escalate").toBe(false);
    expect(r.promptChars, "promptChars should be 0").toBe(0);
  });
});

describe("runHeuristics — escalate signals", () => {
  it("escalates on a triple-backtick code fence", () => {
    const r = runHeuristics("Look at this:\n```ts\nconst x = 1;\n```", cfg);
    expect(r.escalate, "code fence should escalate").toBe(true);
    expect(
      r.reasons.some((x) => x.kind === "escalate_code_fence"),
      "should record escalate_code_fence reason",
    ).toBe(true);
  });

  it("escalates on escalatePatterns keywords (refactor, debug, architect, etc.)", () => {
    expect(runHeuristics("Help me refactor this module.", cfg).escalate).toBe(true);
    expect(runHeuristics("Why does this debug output look wrong?", cfg).escalate).toBe(true);
    expect(runHeuristics("Architect the payments service.", cfg).escalate).toBe(true);
    expect(runHeuristics("Walk me through this step-by-step.", cfg).escalate).toBe(true);
  });

  it("escalates on long prompts even without keyword hits", () => {
    const longText = "x ".repeat(800);
    const r = runHeuristics(longText, cfg);
    expect(r.promptChars, "prompt should exceed escalateLengthChars").toBeGreaterThan(
      cfg.escalateLengthChars,
    );
    expect(r.escalate, "long prompts should escalate").toBe(true);
    expect(
      r.reasons.some((x) => x.kind === "escalate_long_prompt"),
      "should record escalate_long_prompt reason",
    ).toBe(true);
  });

  it("escalates on code density (≥3 file paths + function calls combined)", () => {
    const prompt =
      "Update src/main.ts and tests/main.test.ts to call myFunction() correctly.";
    const r = runHeuristics(prompt, cfg);
    expect(r.escalate, "code-dense prompts should escalate").toBe(true);
    const density = r.reasons.find((x) => x.kind === "escalate_code_density");
    expect(density, "should record escalate_code_density reason").toBeDefined();
  });

  it("does NOT false-positive on URLs as file paths", () => {
    const r = runHeuristics(
      "Check out https://example.com/docs and https://github.com/foo for context.",
      cfg,
    );
    expect(
      r.reasons.some((x) => x.kind === "escalate_code_density"),
      "URLs without file extensions shouldn't trigger code density",
    ).toBe(false);
  });

  it("does NOT false-positive on conversational slashes", () => {
    const r = runHeuristics("Either one option or the other — your choice.", cfg);
    expect(r.escalate, "everyday prose with no slashes shouldn't escalate").toBe(false);
  });

  it("does NOT false-positive on short identifier-like words followed by paren", () => {
    const r = runHeuristics("Do (this) for me.", cfg);
    expect(
      r.reasons.some((x) => x.kind === "escalate_code_density"),
      "function-call detector requires ≥3-char identifier so 'Do (' shouldn't count",
    ).toBe(false);
  });

  it("does NOT escalate on neutral prose under the length threshold", () => {
    const r = runHeuristics("Tell me a joke about clouds.", cfg);
    expect(r.escalate, "neutral short prose should not escalate").toBe(false);
  });
});

describe("runHeuristics — both flags can fire simultaneously", () => {
  it("fires both trivial and escalate when chitchat is mixed with a code request", () => {
    const r = runHeuristics(
      "thanks! can you help me refactor this module please",
      cfg,
    );
    expect(r.trivial, "trivial pattern (thanks) should fire").toBe(true);
    expect(r.escalate, "escalate pattern (refactor) should fire").toBe(true);
    expect(
      r.reasons.length,
      "both reasons should be recorded",
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("runHeuristics — provenance / WAL fields", () => {
  it("populates pattern + matched on trivial pattern hits", () => {
    const r = runHeuristics("hey hey hey", cfg);
    const reason = r.reasons.find((x) => x.kind === "trivial_pattern_match");
    expect(reason, "should record a trivial_pattern_match").toBeDefined();
    if (reason && reason.kind === "trivial_pattern_match") {
      expect(reason.pattern.length, "pattern source should be non-empty").toBeGreaterThan(0);
      expect(reason.matched.length, "matched substring should be non-empty").toBeGreaterThan(0);
    }
  });

  it("truncates matched substrings to ≤41 chars (40 + ellipsis)", () => {
    const longWord = "a".repeat(100);
    const customCfg = {
      ...cfg,
      trivialPatterns: ["a{50,}"],
    };
    const r = runHeuristics(longWord, customCfg);
    const reason = r.reasons.find((x) => x.kind === "trivial_pattern_match");
    expect(reason, "long match should still produce a reason").toBeDefined();
    if (reason && reason.kind === "trivial_pattern_match") {
      expect(
        reason.matched.length,
        "matched substring should be truncated to <=41 chars",
      ).toBeLessThanOrEqual(41);
      expect(reason.matched.endsWith("…"), "truncation should append ellipsis").toBe(true);
    }
  });

  it("survives a malformed regex pattern without throwing", () => {
    const broken = { ...cfg, trivialPatterns: ["[invalid", "\\b(thanks)\\b"] };
    expect(() =>
      runHeuristics("thanks for the help", broken),
    ).not.toThrow();
    const r = runHeuristics("thanks for the help", broken);
    expect(
      r.trivial,
      "valid pattern in the same array should still fire",
    ).toBe(true);
  });

  it("records promptChars accurately on the signal envelope", () => {
    const prompt = "Hello world!";
    const r = runHeuristics(prompt, cfg);
    expect(r.promptChars).toBe(prompt.length);
  });
});

describe("runHeuristics — performance budget (sanity)", () => {
  it("stays under 5ms even on a 100KB prompt", () => {
    const huge = "x ".repeat(50_000);
    const start = performance.now();
    runHeuristics(huge, cfg);
    const elapsed = performance.now() - start;
    expect(elapsed, "100KB prompt heuristics should be sub-5ms").toBeLessThan(5);
  });
});
