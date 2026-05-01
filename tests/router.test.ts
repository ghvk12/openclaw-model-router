import { describe, it, expect } from "vitest";
import { toModelOverride } from "../src/router.js";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import type { RoutingDecision, TierId } from "../src/classifier/types.js";

/**
 * Pure-function tests for the Step 7 GO-LIVE mapper. No I/O, no SDK
 * mocking — just verifies the mapping behavior captured in DESIGN.md
 * §16.3:
 *   - liveRouting=false → undefined (observability mode preserved)
 *   - liveRouting=true  → { modelOverride, providerOverride } from
 *                          cfg.tiers[decision.tier]
 *   - missing tier      → undefined (defensive fallback)
 *   - all four tiers map correctly with the new monotonic ladder
 */

function makeDecision(tier: TierId): RoutingDecision {
  return {
    tier,
    confidence: 0.9,
    classifiers: ["heuristic_default"],
    reason: "test",
  };
}

describe("toModelOverride", () => {
  it("returns undefined when liveRouting=false (observability-only mode)", () => {
    const cfg = resolveConfig({}); // liveRouting defaults to false
    const result = toModelOverride(makeDecision("T1"), cfg);
    expect(result, "must NOT emit override when liveRouting is off").toBeUndefined();
  });

  it("returns { modelOverride, providerOverride } when liveRouting=true (T1 default)", () => {
    const cfg = resolveConfig({ liveRouting: true });
    const result = toModelOverride(makeDecision("T1"), cfg);
    expect(result, "must emit an override when liveRouting is on").toBeDefined();
    expect(result?.providerOverride).toBe("deepseek");
    expect(result?.modelOverride).toBe("deepseek-v4-pro");
  });

  it("maps T0 → deepseek/deepseek-v4-flash (cheapest tier)", () => {
    const cfg = resolveConfig({ liveRouting: true });
    const result = toModelOverride(makeDecision("T0"), cfg);
    expect(result?.providerOverride).toBe("deepseek");
    expect(result?.modelOverride).toBe("deepseek-v4-flash");
  });

  it("maps T2 → google/gemini-3.1-pro-preview (reasoning tier)", () => {
    const cfg = resolveConfig({ liveRouting: true });
    const result = toModelOverride(makeDecision("T2"), cfg);
    expect(result?.providerOverride).toBe("google");
    // Dots, not hyphens — matches the actual Google Gemini API model
    // ID (the bundled `google` provider's onboard.js declares
    // `GOOGLE_GEMINI_DEFAULT_MODEL = "google/gemini-3.1-pro-preview"`).
    // Hyphenated `gemini-3-1-pro-preview` is the Venice-extension ID,
    // which the google provider does NOT understand.
    expect(result?.modelOverride).toBe("gemini-3.1-pro-preview");
  });

  it("maps T3 → anthropic/claude-opus-4-6 (long-context / multimodal tier)", () => {
    const cfg = resolveConfig({ liveRouting: true });
    const result = toModelOverride(makeDecision("T3"), cfg);
    expect(result?.providerOverride).toBe("anthropic");
    expect(result?.modelOverride).toBe("claude-opus-4-6");
  });

  it("respects user tier overrides (e.g. swapping T2 to a different provider)", () => {
    const cfg = resolveConfig({
      liveRouting: true,
      tiers: { T2: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
    } as unknown);
    const result = toModelOverride(makeDecision("T2"), cfg);
    expect(result?.providerOverride, "user T2 override should propagate").toBe("anthropic");
    expect(result?.modelOverride).toBe("claude-sonnet-4-20250514");
  });

  it("returns undefined when the tier is missing from cfg.tiers (defensive belt-and-braces)", () => {
    // This shouldn't happen in practice — TypeScript prevents it and DEFAULTS
    // always populate all 4 tiers — but we explicitly defend against runtime
    // mutation or future schema changes that loosen this invariant.
    const cfg = resolveConfig({ liveRouting: true });
    const mutated: ResolvedConfig = {
      ...cfg,
      tiers: { ...cfg.tiers, T2: undefined as unknown as ResolvedConfig["tiers"]["T2"] },
    };
    const result = toModelOverride(makeDecision("T2"), mutated);
    expect(
      result,
      "missing tier must degrade to undefined, not emit a malformed override",
    ).toBeUndefined();
  });

  it("is a pure function (calling twice returns equal results, no side effects)", () => {
    const cfg = resolveConfig({ liveRouting: true });
    const decision = makeDecision("T1");
    const r1 = toModelOverride(decision, cfg);
    const r2 = toModelOverride(decision, cfg);
    expect(r1, "purity: identical inputs → equal outputs").toEqual(r2);
    // Same identity not required (different object literal) but values must equal.
    expect(r1?.modelOverride).toBe(r2?.modelOverride);
  });
});
