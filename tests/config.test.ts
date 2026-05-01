import { describe, it, expect } from "vitest";
import {
  assertSecureUrl,
  resolveConfig,
  summarizeConfig,
  type ResolvedConfig,
} from "../src/config.js";

/**
 * Pure-function config tests. No I/O, no network — runs in <100ms locally.
 *
 * Coverage targets (per DESIGN.md §14 acceptance criteria):
 *   - DEFAULTS round-trip: empty config produces a valid ResolvedConfig
 *   - per-section override: user can override a single tier without losing
 *     the others
 *   - security gate: assertSecureUrl rejects every plaintext non-loopback URL
 *   - tier id validation: invalid defaultTier throws (not silently coerced)
 *   - URL malformedness: a non-URL string throws
 */

describe("resolveConfig", () => {
  it("returns DEFAULTS for an empty config", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled, "enabled should default to true").toBe(true);
    expect(cfg.liveRouting, "liveRouting should default to false (Step 7 safety valve)").toBe(false);
    expect(cfg.defaultTier, "defaultTier should default to T1").toBe("T1");
    expect(cfg.tiers.T0.provider, "T0 should default to deepseek").toBe("deepseek");
    expect(cfg.tiers.T0.model, "T0 should default to deepseek-v4-flash").toBe("deepseek-v4-flash");
    expect(cfg.tiers.T1.provider, "T1 should default to deepseek").toBe("deepseek");
    expect(cfg.tiers.T1.model, "T1 should default to deepseek-v4-pro").toBe("deepseek-v4-pro");
    expect(cfg.tiers.T2.provider, "T2 should default to google (NOT 'gemini' which would fail validation)").toBe("google");
    expect(cfg.tiers.T2.model, "T2 should default to gemini-3.1-pro-preview (dots, matches actual Google Gemini API)").toBe("gemini-3.1-pro-preview");
    expect(cfg.tiers.T3.provider, "T3 should default to anthropic").toBe("anthropic");
    expect(cfg.tiers.T3.model, "T3 should default to claude-opus-4-6").toBe("claude-opus-4-6");
    expect(
      cfg.classifier.longContextThreshold,
      "longContextThreshold should default to 200K",
    ).toBe(200000);
    expect(
      cfg.classifier.semantic.enabled,
      "semantic classifier should default to enabled",
    ).toBe(true);
    expect(
      cfg.observability.walDir,
      "walDir should default to ~/.openclaw/model-router/wal",
    ).toBe("~/.openclaw/model-router/wal");
  });

  it("returns DEFAULTS for null/undefined/non-object input", () => {
    expect(resolveConfig(null).enabled, "null should resolve to defaults").toBe(true);
    expect(resolveConfig(undefined).enabled, "undefined should resolve to defaults").toBe(
      true,
    );
    expect(resolveConfig("garbage").enabled, "string should resolve to defaults").toBe(
      true,
    );
    expect(resolveConfig(42).enabled, "number should resolve to defaults").toBe(true);
    expect(resolveConfig(null).liveRouting, "null should resolve liveRouting to false").toBe(false);
  });

  it("merges enabled flag without disturbing other defaults", () => {
    const cfg = resolveConfig({ enabled: false });
    expect(cfg.enabled, "enabled override should land").toBe(false);
    expect(cfg.tiers.T1.model, "tier defaults should still apply").toBe(
      "deepseek-v4-pro",
    );
  });

  it("respects an explicit liveRouting=true override (the Step 7 GO-LIVE flip)", () => {
    const cfg = resolveConfig({ liveRouting: true });
    expect(cfg.liveRouting, "liveRouting=true override should land").toBe(true);
    expect(cfg.enabled, "other defaults should remain").toBe(true);
    expect(cfg.tiers.T1.model, "tier defaults should remain").toBe("deepseek-v4-pro");
  });

  it("respects an explicit liveRouting=false override (kill-switch path)", () => {
    const cfg = resolveConfig({ liveRouting: false, enabled: true });
    expect(cfg.liveRouting, "explicit false should land (not override default)").toBe(false);
  });

  it("allows overriding a single tier without losing the others", () => {
    const cfg = resolveConfig({
      tiers: { T2: { provider: "anthropic", model: "claude-sonnet-4-20250514" } },
    } as unknown);
    expect(cfg.tiers.T2.provider, "T2 override should land").toBe("anthropic");
    expect(cfg.tiers.T2.model, "T2 model should land").toBe("claude-sonnet-4-20250514");
    expect(cfg.tiers.T0.provider, "T0 should remain at default").toBe("deepseek");
    expect(cfg.tiers.T1.model, "T1 should remain at default").toBe("deepseek-v4-pro");
    expect(cfg.tiers.T3.model, "T3 should remain at default").toBe("claude-opus-4-6");
  });

  it("merges nested classifier.semantic.qdrant fields", () => {
    const cfg = resolveConfig({
      classifier: {
        semantic: {
          qdrant: { collection: "my_router_v2_exemplars" },
        },
      },
    } as unknown);
    expect(
      cfg.classifier.semantic.qdrant.collection,
      "user collection name should win",
    ).toBe("my_router_v2_exemplars");
    expect(
      cfg.classifier.semantic.qdrant.url,
      "qdrant.url should remain at default",
    ).toBe("http://localhost:6333");
    expect(
      cfg.classifier.semantic.embeddings.model,
      "unrelated embeddings.model should remain at default",
    ).toBe("mxbai-embed-large");
    expect(
      cfg.classifier.longContextThreshold,
      "unrelated classifier.longContextThreshold should remain at default",
    ).toBe(200000);
  });

  it("replaces (does not merge) array fields wholesale", () => {
    const cfg = resolveConfig({
      classifier: {
        heuristics: { trivialPatterns: ["\\bcustom\\b"] },
      },
    } as unknown);
    expect(
      cfg.classifier.heuristics.trivialPatterns,
      "trivialPatterns should be the user's array, not a merge",
    ).toEqual(["\\bcustom\\b"]);
    expect(
      cfg.classifier.heuristics.escalatePatterns.length,
      "escalatePatterns should fall back to defaults",
    ).toBeGreaterThan(0);
  });

  it("throws on an invalid defaultTier (not silently coerced)", () => {
    expect(() => resolveConfig({ defaultTier: "T5" } as unknown)).toThrow(
      /defaultTier must be one of T0\|T1\|T2\|T3/,
    );
  });

  it("throws when tiers.T0.url is a plaintext non-loopback host", () => {
    expect(() =>
      resolveConfig({
        tiers: { T0: { provider: "ollama", model: "qwen2.5:7b", url: "http://evil.example.com:11434" } },
      } as unknown),
    ).toThrow(/tiers\.T0\.url uses plaintext http:\/\/ to a non-loopback host/);
  });

  it("throws when classifier.semantic.qdrant.url is a plaintext non-loopback host", () => {
    expect(() =>
      resolveConfig({
        classifier: {
          semantic: { qdrant: { url: "http://203.0.113.42:6333" } },
        },
      } as unknown),
    ).toThrow(/classifier\.semantic\.qdrant\.url uses plaintext http:\/\//);
  });

  it("throws when classifier.semantic.embeddings.url is a plaintext non-loopback host", () => {
    expect(() =>
      resolveConfig({
        classifier: {
          semantic: { embeddings: { url: "http://prod-ollama.internal:11434" } },
        },
      } as unknown),
    ).toThrow(/classifier\.semantic\.embeddings\.url uses plaintext http:\/\//);
  });
});

describe("assertSecureUrl", () => {
  it("accepts loopback hosts on http://", () => {
    expect(() => assertSecureUrl("test", "http://localhost:6333")).not.toThrow();
    expect(() => assertSecureUrl("test", "http://127.0.0.1:6333")).not.toThrow();
    expect(() => assertSecureUrl("test", "http://[::1]:6333")).not.toThrow();
    expect(() => assertSecureUrl("test", "http://app.localhost:6333")).not.toThrow();
  });

  it("accepts any host on https://", () => {
    expect(() => assertSecureUrl("test", "https://qdrant.example.com")).not.toThrow();
    expect(() => assertSecureUrl("test", "https://203.0.113.42:6333")).not.toThrow();
  });

  it("rejects plaintext http:// to non-loopback hosts", () => {
    expect(() => assertSecureUrl("qdrant.url", "http://qdrant.example.com")).toThrow(
      /qdrant\.url uses plaintext http:\/\//,
    );
    expect(() => assertSecureUrl("test", "http://10.0.0.5:6333")).toThrow();
  });

  it("rejects unknown protocols", () => {
    expect(() => assertSecureUrl("test", "ftp://example.com")).toThrow(
      /must use http:\/\/ or https:\/\//,
    );
    expect(() => assertSecureUrl("test", "ws://example.com")).toThrow();
  });

  it("rejects malformed URLs with the field name in the error", () => {
    expect(() => assertSecureUrl("classifier.semantic.qdrant.url", "not a url")).toThrow(
      /classifier\.semantic\.qdrant\.url is not a valid URL/,
    );
  });
});

describe("summarizeConfig", () => {
  it("produces a single-line operator-readable summary with the new defaults", () => {
    const cfg: ResolvedConfig = resolveConfig({});
    const summary = summarizeConfig(cfg);
    expect(summary, "summary should be a single line").not.toContain("\n");
    expect(summary).toContain("enabled=true");
    expect(summary).toContain("liveRouting=observability-only");
    expect(summary).toContain("default=T1");
    expect(summary).toContain("T0=deepseek/deepseek-v4-flash");
    expect(summary).toContain("T1=deepseek/deepseek-v4-pro");
    expect(summary).toContain("T2=google/gemini-3.1-pro-preview");
    expect(summary).toContain("T3=anthropic/claude-opus-4-6");
    expect(summary, "should reflect classifier wiring").toContain("classifier=heuristic+semantic");
  });

  it("reflects an enabled=false override", () => {
    const cfg = resolveConfig({ enabled: false });
    expect(summarizeConfig(cfg)).toContain("enabled=false");
  });

  it("reflects a disabled semantic classifier", () => {
    const cfg = resolveConfig({
      classifier: { semantic: { enabled: false } },
    } as unknown);
    expect(summarizeConfig(cfg)).toContain("semantic(disabled)");
  });

  it("flips the liveRouting field in the summary when liveRouting=true", () => {
    const cfg = resolveConfig({ liveRouting: true });
    const summary = summarizeConfig(cfg);
    expect(summary, "summary should signal LIVE state to operators reading boot logs").toContain("liveRouting=LIVE");
    expect(summary, "should NOT contain the observability-only string when live").not.toContain("observability-only");
  });
});
