import { describe, it, expect } from "vitest";
import { stubDecide } from "../src/decider-stub.js";
import { resolveConfig } from "../src/config.js";
import { runHeuristics } from "../src/classifier/heuristics.js";

/**
 * Stub decider tests. The Step 4 stub is intentionally trivial — its
 * contract is "always return T1, with a reason that describes what the
 * heuristic detected." These tests guard that contract so the swap to the
 * real decider in Step 6 doesn't accidentally regress to "always T1."
 */

const cfg = resolveConfig({});

describe("stubDecide — always returns T1", () => {
  it("returns T1 even when heuristic flags trivial", () => {
    const sig = runHeuristics("ok thanks", cfg.classifier.heuristics);
    expect(sig.trivial, "test setup: heuristic should flag trivial").toBe(true);
    const dec = stubDecide(sig, cfg);
    expect(dec.tier, "stub must always return T1, even on trivial").toBe("T1");
  });

  it("returns T1 even when heuristic flags escalate", () => {
    const sig = runHeuristics("Refactor src/main.ts step-by-step", cfg.classifier.heuristics);
    expect(sig.escalate, "test setup: heuristic should flag escalate").toBe(true);
    const dec = stubDecide(sig, cfg);
    expect(dec.tier, "stub must always return T1, even on escalate").toBe("T1");
  });

  it("returns T1 on neutral prompts", () => {
    const sig = runHeuristics("Tell me about yesterday's weather forecast", cfg.classifier.heuristics);
    const dec = stubDecide(sig, cfg);
    expect(dec.tier).toBe("T1");
  });

  it("returns T1 on the empty prompt", () => {
    const sig = runHeuristics("", cfg.classifier.heuristics);
    const dec = stubDecide(sig, cfg);
    expect(dec.tier).toBe("T1");
  });
});

describe("stubDecide — decision envelope shape", () => {
  it("uses 0.5 confidence (medium — signals stub-ness)", () => {
    const sig = runHeuristics("hi", cfg.classifier.heuristics);
    expect(stubDecide(sig, cfg).confidence).toBe(0.5);
  });

  it("includes 'heuristic_default' as the only classifier label", () => {
    const sig = runHeuristics("hi", cfg.classifier.heuristics);
    expect(stubDecide(sig, cfg).classifiers).toEqual(["heuristic_default"]);
  });

  it("includes 'stub decider (always T1)' prefix in the reason", () => {
    const sig = runHeuristics("hi", cfg.classifier.heuristics);
    expect(stubDecide(sig, cfg).reason).toMatch(/^stub decider \(always T1\) — heuristic:/);
  });
});

describe("stubDecide — reason describes heuristic provenance", () => {
  it("labels neutral prompts as 'neutral'", () => {
    const sig = runHeuristics(
      "Please consider the implications of moving forward with the planned approach when you have time.",
      cfg.classifier.heuristics,
    );
    expect(sig.trivial, "test setup: prompt should be neutral").toBe(false);
    expect(sig.escalate, "test setup: prompt should be neutral").toBe(false);
    expect(stubDecide(sig, cfg).reason).toContain("neutral");
  });

  it("labels trivial-only prompts as 'trivial'", () => {
    const sig = runHeuristics("ok cool thanks", cfg.classifier.heuristics);
    const reason = stubDecide(sig, cfg).reason;
    expect(reason).toContain("trivial");
    expect(reason, "trivial-only should not say 'escalate' or '+escalate'").not.toContain(
      "escalate",
    );
  });

  it("labels escalate-only prompts as 'escalate'", () => {
    // Must be > maxTrivialChars (80) to skip the short_no_question trivial
    // rule and isolate the escalate-only path.
    const sig = runHeuristics(
      "Please refactor the payment service to handle retries correctly when downstream APIs return 5xx errors temporarily.",
      cfg.classifier.heuristics,
    );
    expect(sig.trivial, "test setup: should be escalate-only").toBe(false);
    expect(sig.escalate, "test setup: should escalate on 'refactor'").toBe(true);
    const reason = stubDecide(sig, cfg).reason;
    expect(reason).toContain("escalate");
    expect(reason, "escalate-only should not start a 'trivial+' tag").not.toContain(
      "trivial+",
    );
  });

  it("labels both-flag prompts as 'trivial+escalate'", () => {
    const sig = runHeuristics(
      "thanks! can you refactor this please",
      cfg.classifier.heuristics,
    );
    expect(sig.trivial && sig.escalate, "test setup: both flags should fire").toBe(true);
    expect(stubDecide(sig, cfg).reason).toContain("trivial+escalate");
  });

  it("includes pattern-match details in the reason for tunability", () => {
    const sig = runHeuristics("please refactor this", cfg.classifier.heuristics);
    expect(stubDecide(sig, cfg).reason).toContain("escalate_pattern_match:");
  });
});
