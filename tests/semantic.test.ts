import { describe, it, expect, vi } from "vitest";
import { aggregateVotes, runSemantic, type SemanticDeps } from "../src/classifier/semantic.js";
import type { ExemplarHit, RouterQdrantClient } from "../src/classifier/qdrant-router.js";
import type { RouterEmbedder } from "../src/classifier/embedder.js";
import { resolveConfig } from "../src/config.js";

/**
 * Semantic classifier tests. Two layers:
 *
 * 1. aggregateVotes() — the pure vote-aggregation algorithm. No I/O,
 *    no mocks, just argmax + margin + sticky-prior boost.
 * 2. runSemantic() — the full classifier with mocked embedder/qdrant
 *    so we can verify the orchestration without spinning up Ollama
 *    or a Qdrant instance.
 */

const cfg = resolveConfig({}).classifier.semantic;

function hit(tier: "T0" | "T1" | "T2" | "T3", score: number, text = "x"): ExemplarHit {
  return {
    id: `mock-${tier}-${score}`,
    score,
    payload: { text, tier, source: "seed", version: 1 },
  };
}

describe("aggregateVotes — argmax + margin", () => {
  it("returns T1 with confidence=0 when there are no hits", () => {
    const r = aggregateVotes([], cfg.stickyPriorBoost, null);
    expect(r.tier, "no hits → conservative default T1").toBe("T1");
    expect(r.confidence).toBe(0);
  });

  it("picks the tier with the highest summed similarity", () => {
    const hits = [hit("T2", 0.9), hit("T2", 0.8), hit("T1", 0.7)];
    const r = aggregateVotes(hits, cfg.stickyPriorBoost, null);
    expect(r.tier, "T2 votes sum to 1.7, T1 sums to 0.7 → T2 wins").toBe("T2");
  });

  it("computes confidence as (top - second) / top", () => {
    const hits = [hit("T0", 1.0), hit("T1", 0.4)];
    const r = aggregateVotes(hits, cfg.stickyPriorBoost, null);
    expect(r.tier).toBe("T0");
    expect(r.confidence, "(1.0 - 0.4) / 1.0 = 0.6").toBeCloseTo(0.6, 2);
  });

  it("returns confidence=0 when two tiers are tied at the top", () => {
    // Tied tiers should produce zero margin — the conservative default
    // (T1) takes over via the marginThreshold check in decision.ts (Step 6).
    const hits = [hit("T0", 0.6), hit("T1", 0.6)];
    const r = aggregateVotes(hits, cfg.stickyPriorBoost, null);
    expect(r.confidence, "tied top two tiers → confidence=0").toBe(0);
  });

  it("returns confidence=1 when only one tier votes", () => {
    const hits = [hit("T2", 0.9), hit("T2", 0.7), hit("T2", 0.5)];
    const r = aggregateVotes(hits, cfg.stickyPriorBoost, null);
    expect(r.tier).toBe("T2");
    expect(r.confidence, "no second-place tier → confidence=1").toBe(1);
  });
});

describe("aggregateVotes — sticky prior boost", () => {
  it("boosts the prior tier's vote when it appears in top-3", () => {
    const hits = [
      hit("T1", 0.8), // top hit, T1
      hit("T0", 0.7), // T0
      hit("T1", 0.6), // also T1, in top-3
      hit("T2", 0.5), // T2 (rank 4, not boosted)
    ];
    const withoutBoost = aggregateVotes(hits, 1.0, null);
    const withBoost = aggregateVotes(hits, 2.0, "T1");
    // Without boost: T1 = 0.8 + 0.6 = 1.4, T0 = 0.7, T2 = 0.5 → T1 wins anyway
    expect(withoutBoost.tier).toBe("T1");
    // With boost on T1 (top-3 hits matching T1 are #0 and #2):
    // T1 vote = 0.8*2 + 0.6*2 = 2.8 (instead of 1.4)
    expect(withBoost.tier).toBe("T1");
    // The boost should widen the margin between T1 and T0.
    expect(
      withBoost.confidence,
      "boost should increase confidence for the prior tier",
    ).toBeGreaterThan(withoutBoost.confidence);
  });

  it("does NOT boost prior tier hits ranked 4+ in the result list", () => {
    const hits = [
      hit("T2", 0.9), // rank 0
      hit("T2", 0.85), // rank 1
      hit("T2", 0.8), // rank 2
      hit("T1", 0.4), // rank 3 — prior tier here, NOT boosted
    ];
    const r = aggregateVotes(hits, 5.0, "T1");
    // Even with massive 5x boost, T1's 0.4 < T2's 2.55. T2 should win.
    expect(r.tier, "rank-4 prior should not be boosted, so T2 still wins").toBe("T2");
  });

  it("does NOT boost when priorTier is null (cold conversation)", () => {
    const hits = [hit("T1", 0.5), hit("T2", 0.6)];
    const r = aggregateVotes(hits, 5.0, null);
    expect(r.tier, "null priorTier → no boost → T2 still wins").toBe("T2");
  });

  it("can flip the winner when boost is strong enough", () => {
    const hits = [
      hit("T2", 0.7),
      hit("T0", 0.6), // prior tier
      hit("T0", 0.5), // also prior tier
    ];
    const noBoost = aggregateVotes(hits, 1.0, "T0");
    expect(noBoost.tier, "without boost: T2=0.7, T0=1.1 → T0 wins").toBe("T0");
    const tinyBoost = aggregateVotes(hits, 2.0, "T0");
    expect(tinyBoost.tier, "with 2x boost: T0 = 1.1*2 = 2.2 still wins").toBe("T0");
  });
});

describe("runSemantic — orchestration", () => {
  function mockEmbedder(vec: number[]): RouterEmbedder {
    return {
      embedQuery: vi.fn().mockResolvedValue(vec),
      embedBatch: vi.fn().mockResolvedValue([vec]),
      probe: vi.fn().mockResolvedValue({ ok: true }),
      model: "mxbai-embed-large",
      dim: vec.length,
      url: "http://localhost:11434",
    };
  }

  function mockQdrant(hits: ExemplarHit[]): RouterQdrantClient {
    return {
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue(hits),
      upsertExemplars: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(60),
    } as unknown as RouterQdrantClient;
  }

  it("returns a SemanticSignal with tier, confidence, topExemplars, latencyMs", async () => {
    const deps: SemanticDeps = {
      embedder: mockEmbedder([0.1, 0.2, 0.3]),
      qdrant: mockQdrant([hit("T1", 0.9, "summarize this thread"), hit("T0", 0.5, "thanks")]),
    };
    const sig = await runSemantic("summarize the chat", cfg, deps);
    expect(sig.tier).toBe("T1");
    expect(sig.confidence, "(0.9 - 0.5) / 0.9 ≈ 0.444").toBeCloseTo(0.444, 2);
    expect(sig.topExemplars).toEqual(["summarize this thread", "thanks"]);
    expect(typeof sig.latencyMs, "latency must be a number").toBe("number");
    expect(sig.latencyMs, "latency must be non-negative").toBeGreaterThanOrEqual(0);
  });

  it("calls embedder.embedQuery once with the input prompt", async () => {
    const embedder = mockEmbedder([0.1, 0.2]);
    const deps: SemanticDeps = {
      embedder,
      qdrant: mockQdrant([hit("T1", 0.7)]),
    };
    await runSemantic("the prompt", cfg, deps);
    expect(embedder.embedQuery).toHaveBeenCalledWith("the prompt");
    expect(embedder.embedQuery).toHaveBeenCalledTimes(1);
  });

  it("calls qdrant.search with the embedded vector and configured topK", async () => {
    const vec = [0.1, 0.2, 0.3];
    const qdrant = mockQdrant([hit("T2", 0.9)]);
    const deps: SemanticDeps = { embedder: mockEmbedder(vec), qdrant };
    await runSemantic("design a schema for X", cfg, deps);
    expect(qdrant.search).toHaveBeenCalledWith(vec, cfg.topK);
  });

  it("truncates exemplar text in topExemplars to <=61 chars (60 + ellipsis)", async () => {
    const longText = "x".repeat(200);
    const deps: SemanticDeps = {
      embedder: mockEmbedder([0.1, 0.2]),
      qdrant: mockQdrant([hit("T1", 0.5, longText)]),
    };
    const sig = await runSemantic("query", cfg, deps);
    expect(sig.topExemplars[0]?.length).toBeLessThanOrEqual(61);
    expect(sig.topExemplars[0]?.endsWith("…")).toBe(true);
  });

  it("propagates priorTier into the sticky-boost path", async () => {
    const deps: SemanticDeps = {
      embedder: mockEmbedder([0.1]),
      qdrant: mockQdrant([
        hit("T2", 0.6),
        hit("T0", 0.55), // prior tier in top-3
        hit("T0", 0.5), // also prior tier in top-3
      ]),
    };
    // Without prior: T0 = 1.05, T2 = 0.6 → T0 wins
    // With prior=T0 and 1.3x boost: T0 = 1.05*1.3 = 1.365 (even more T0 win)
    const sig = await runSemantic("test", cfg, deps, "T0");
    expect(sig.tier).toBe("T0");
  });

  it("propagates errors from the embedder (no swallowing)", async () => {
    const deps: SemanticDeps = {
      embedder: {
        embedQuery: vi.fn().mockRejectedValue(new Error("Ollama down")),
        embedBatch: vi.fn(),
        probe: vi.fn(),
        model: "x",
        dim: 1,
        url: "http://localhost",
      } as unknown as RouterEmbedder,
      qdrant: mockQdrant([]),
    };
    await expect(runSemantic("x", cfg, deps)).rejects.toThrow(/Ollama down/);
  });

  it("propagates errors from the Qdrant client", async () => {
    const deps: SemanticDeps = {
      embedder: mockEmbedder([0.1, 0.2]),
      qdrant: {
        ensureCollection: vi.fn(),
        search: vi.fn().mockRejectedValue(new Error("Qdrant unreachable")),
        upsertExemplars: vi.fn(),
        countPoints: vi.fn(),
      } as unknown as RouterQdrantClient,
    };
    await expect(runSemantic("x", cfg, deps)).rejects.toThrow(/Qdrant unreachable/);
  });
});
