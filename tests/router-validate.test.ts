import { describe, it, expect } from "vitest";
import {
  validateTiers,
  formatValidationError,
  type GatewayConfigShape,
  type TierValidationIssue,
} from "../src/router-validate.js";
import { resolveConfig } from "../src/config.js";

/**
 * Tier-validation tests (DESIGN.md §16.4). Pure functions — no I/O,
 * no SDK dependencies. Tests stub `gatewayConfig` directly.
 *
 * Coverage:
 *   - happy path (every tier resolves)
 *   - per-tier failure modes (missing provider, missing models[],
 *     model not in models[])
 *   - defensive paths (missing gatewayConfig, missing providers map)
 *   - error-message formatting (3-option recovery hint embedded)
 */

function fullProvidersForDefaults(): GatewayConfigShape {
  return {
    models: {
      providers: {
        deepseek: {
          models: [
            { id: "deepseek-v4-flash" },
            { id: "deepseek-v4-pro" },
            { id: "deepseek-chat" }, // legacy id; harmless extra
          ],
        },
        google: {
          models: [{ id: "gemini-3.1-pro-preview" }, { id: "gemini-3-pro-preview" }],
        },
        anthropic: {
          models: [{ id: "claude-opus-4-6" }, { id: "claude-sonnet-4-20250514" }],
        },
      },
    },
  };
}

describe("validateTiers — happy paths", () => {
  it("returns no issues when every tier resolves to a known provider+model", () => {
    const cfg = resolveConfig({});
    const issues = validateTiers(cfg, fullProvidersForDefaults());
    expect(issues, "fully-configured gateway should pass validation cleanly").toEqual([]);
  });

  it("returns no issues when extra unrelated providers/models are present", () => {
    const cfg = resolveConfig({});
    const gw = fullProvidersForDefaults();
    gw.models!.providers!.openai = { models: [{ id: "gpt-5" }] };
    const issues = validateTiers(cfg, gw);
    expect(issues, "extra providers should not affect validation").toEqual([]);
  });
});

describe("validateTiers — POSITIVE-EVIDENCE rule (only flag model-present-but-wrong)", () => {
  it("does NOT flag a missing provider — could be bundled (e.g. ollama, azure)", () => {
    // Per the positive-evidence rule (DESIGN.md §16.4 spec): a provider
    // not in user openclaw.json could still be a bundled provider in
    // OpenClaw's runtime catalog. We can't disprove existence from
    // user config alone, so we skip rather than fail.
    const cfg = resolveConfig({
      tiers: { T2: { provider: "azure", model: "gpt-4" } },
    } as unknown);
    const issues = validateTiers(cfg, fullProvidersForDefaults());
    expect(
      issues,
      "missing provider must NOT be flagged — bundled-catalog blind spot",
    ).toEqual([]);
  });

  it("flags a present provider with a model NOT in its models[] (only positive-evidence case)", () => {
    const cfg = resolveConfig({
      tiers: { T1: { provider: "deepseek", model: "deepseek-v9-superflash" } },
    } as unknown);
    const issues = validateTiers(cfg, fullProvidersForDefaults());
    expect(issues, "model-mismatch IS positive evidence — should flag").toHaveLength(1);
    expect(issues[0].tier).toBe("T1");
    expect(issues[0].reason).toMatch(/model "deepseek-v9-superflash" not found/);
    expect(issues[0].reason, "should list known models for the provider").toContain("deepseek-v4-flash");
    expect(
      issues[0].reason,
      "should explain the positive-evidence caveat (bundled may still supply it)",
    ).toContain("bundled provider catalogs may still supply this model");
  });

  it("does NOT flag a provider with no models[] array — bundled-only override", () => {
    const cfg = resolveConfig({});
    const gw = fullProvidersForDefaults();
    gw.models!.providers!.google = {}; // present but no models[] — auth-only override
    const issues = validateTiers(cfg, gw);
    expect(
      issues,
      "provider with no models[] is treated as bundled-only — no flag",
    ).toEqual([]);
  });

  it("only flags tiers with model-present-but-wrong (skips bundled-suspect tiers)", () => {
    const cfg = resolveConfig({
      tiers: {
        T0: { provider: "ollama", model: "qwen3" }, // ollama not registered → SKIP (bundled-suspect)
        T2: { provider: "deepseek", model: "deepseek-v9-pro" }, // model not in deepseek's models[] → FLAG
      },
    } as unknown);
    const issues = validateTiers(cfg, fullProvidersForDefaults());
    expect(
      issues,
      "only the deepseek tier should be flagged — ollama tier is bundled-suspect",
    ).toHaveLength(1);
    expect(issues[0].tier).toBe("T2");
  });
});

describe("validateTiers — defensive paths (don't crash on unexpected SDK shapes)", () => {
  it("returns [] when gatewayConfig is undefined (skip-validation fallback)", () => {
    const cfg = resolveConfig({});
    const issues = validateTiers(cfg, undefined);
    expect(
      issues,
      "missing config should NOT throw — defensive vs SDK version skew (DESIGN.md §11)",
    ).toEqual([]);
  });

  it("returns [] when gatewayConfig is null", () => {
    const cfg = resolveConfig({});
    const issues = validateTiers(cfg, null);
    expect(issues).toEqual([]);
  });

  it("returns [] when models.providers is missing", () => {
    const cfg = resolveConfig({});
    const issues = validateTiers(cfg, { models: {} });
    expect(issues).toEqual([]);
  });

  it("returns [] when models.providers is the wrong type (string, array, etc)", () => {
    const cfg = resolveConfig({});
    const issues = validateTiers(cfg, {
      models: { providers: "not-an-object" as unknown as GatewayConfigShape["models"] extends infer T ? T : never },
    } as GatewayConfigShape);
    expect(issues).toEqual([]);
  });
});

describe("formatValidationError", () => {
  function fakeIssue(tier: TierValidationIssue["tier"], reason: string): TierValidationIssue {
    return { tier, reason };
  }

  it("uses singular 'tier' for exactly one issue", () => {
    const msg = formatValidationError([fakeIssue("T2", 'model "x" not found')]);
    expect(msg, "should say '1 tier'").toContain("1 tier misconfigured");
    expect(msg).not.toContain("1 tiers");
  });

  it("uses plural 'tiers' for two or more issues", () => {
    const msg = formatValidationError([
      fakeIssue("T1", "provider missing"),
      fakeIssue("T2", "model missing"),
    ]);
    expect(msg).toContain("2 tiers misconfigured");
  });

  it("embeds all 3 recovery options (a/b/c) in the error text", () => {
    const msg = formatValidationError([fakeIssue("T2", "x")]);
    expect(msg, "option (a): fix the config").toContain("(a) Add the missing");
    expect(msg, "option (b): toggle liveRouting=false").toContain("(b) Set");
    expect(msg).toContain("liveRouting = false");
    expect(msg, "option (c): disable plugin entirely").toContain("(c) Disable the plugin");
  });

  it("lists each tier issue as a bullet with the reason", () => {
    const msg = formatValidationError([
      fakeIssue("T1", "reason-for-T1"),
      fakeIssue("T3", "reason-for-T3"),
    ]);
    expect(msg).toContain("T1: reason-for-T1");
    expect(msg).toContain("T3: reason-for-T3");
  });

  it("is a multi-line string (gateway log writers expected to print literal)", () => {
    const msg = formatValidationError([fakeIssue("T0", "test")]);
    expect(msg, "should contain newlines for visual scanning in boot logs").toContain("\n");
    expect(msg.split("\n").length, "should be at least 10 lines (header + bullets + recovery)").toBeGreaterThanOrEqual(10);
  });
});
