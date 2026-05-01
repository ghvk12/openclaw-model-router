import { describe, it, expect, vi, beforeEach } from "vitest";
import { seedExemplars } from "../src/classifier/seed-exemplars.js";
import { SEED_EXEMPLARS } from "../src/classifier/exemplars.js";
import type { RouterEmbedder } from "../src/classifier/embedder.js";
import type { RouterQdrantClient } from "../src/classifier/qdrant-router.js";
import type { Logger } from "../src/logger.js";

/**
 * Bootstrap orchestration tests. Verifies the idempotency contract
 * (skip-when-already-seeded), the force-rebuild path, and that the
 * uploaded payload shape matches the Qdrant schema.
 */

const logCalls: { level: string; msg: string }[] = [];
const logger: Logger = {
  info: (msg) => logCalls.push({ level: "info", msg }),
  warn: (msg) => logCalls.push({ level: "warn", msg }),
  error: (msg) => logCalls.push({ level: "error", msg }),
};

beforeEach(() => {
  logCalls.length = 0;
});

function mockEmbedder(): RouterEmbedder {
  // Return a unique 1024-dim vector for each input so we can verify
  // upsert preserves order. Exemplar texts feed in by index — the
  // returned vector at position i has its first element = i/N.
  return {
    embedQuery: vi.fn(),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map((_, i) => {
        const v = new Array(1024).fill(0);
        v[0] = i / Math.max(1, texts.length);
        return v;
      }),
    ),
    probe: vi.fn().mockResolvedValue({ ok: true }),
    model: "mxbai-embed-large",
    dim: 1024,
    url: "http://localhost:11434",
  } as unknown as RouterEmbedder;
}

function mockQdrant(existingPoints: number): RouterQdrantClient {
  return {
    ensureCollection: vi.fn().mockResolvedValue(undefined),
    upsertExemplars: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(existingPoints),
    search: vi.fn(),
  } as unknown as RouterQdrantClient;
}

describe("seedExemplars — idempotency", () => {
  it("skips upsert when collection already has >= SEED_EXEMPLARS.length points", async () => {
    const embedder = mockEmbedder();
    const qdrant = mockQdrant(SEED_EXEMPLARS.length);
    const result = await seedExemplars(embedder, qdrant, logger);
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.existingCount).toBe(SEED_EXEMPLARS.length);
      expect(result.expected).toBe(SEED_EXEMPLARS.length);
    }
    expect(embedder.embedBatch, "should not call embedder when skipping").not.toHaveBeenCalled();
    expect(qdrant.upsertExemplars, "should not call upsert when skipping").not.toHaveBeenCalled();
  });

  it("runs full bootstrap when collection has fewer points than expected", async () => {
    const embedder = mockEmbedder();
    const qdrant = mockQdrant(0);
    const result = await seedExemplars(embedder, qdrant, logger);
    expect(result.status).toBe("seeded");
    if (result.status === "seeded") {
      expect(result.pointsWritten).toBe(SEED_EXEMPLARS.length);
      expect(result.durationMs, "duration should be non-negative").toBeGreaterThanOrEqual(0);
    }
    expect(embedder.embedBatch).toHaveBeenCalledTimes(1);
    expect(qdrant.upsertExemplars).toHaveBeenCalledTimes(1);
  });

  it("force=true bypasses the count check and re-runs", async () => {
    const embedder = mockEmbedder();
    const qdrant = mockQdrant(SEED_EXEMPLARS.length);
    const result = await seedExemplars(embedder, qdrant, logger, { force: true });
    expect(result.status).toBe("seeded");
    expect(qdrant.countPoints, "force should skip the count check").not.toHaveBeenCalled();
    expect(embedder.embedBatch).toHaveBeenCalledTimes(1);
  });

  it("ensures the collection exists even when skipping", async () => {
    const qdrant = mockQdrant(SEED_EXEMPLARS.length);
    await seedExemplars(mockEmbedder(), qdrant, logger);
    expect(
      qdrant.ensureCollection,
      "ensureCollection runs unconditionally so the count check has a place to land",
    ).toHaveBeenCalled();
  });
});

describe("seedExemplars — upsert payload shape", () => {
  it("uploads each exemplar with the correct payload (text, tier, source, version)", async () => {
    const embedder = mockEmbedder();
    const qdrant = mockQdrant(0);
    await seedExemplars(embedder, qdrant, logger);

    const upsertCall = (qdrant.upsertExemplars as ReturnType<typeof vi.fn>).mock.calls[0];
    const points = upsertCall?.[0] as Array<{
      id: string;
      vector: number[];
      payload: { text: string; tier: string; source: string; version: number };
    }>;
    expect(points.length).toBe(SEED_EXEMPLARS.length);

    for (let i = 0; i < points.length; i++) {
      const point = points[i]!;
      const expected = SEED_EXEMPLARS[i]!;
      expect(point.id, "id must match the exemplar's deterministic id").toBe(expected.id);
      expect(point.payload.text).toBe(expected.text);
      expect(point.payload.tier).toBe(expected.tier);
      expect(point.payload.source).toBe("seed");
      expect(point.payload.version, "version must be stamped on each point").toBe(1);
    }
  });

  it("uploads vectors in the same order as SEED_EXEMPLARS (no shuffling)", async () => {
    const embedder = mockEmbedder();
    const qdrant = mockQdrant(0);
    await seedExemplars(embedder, qdrant, logger);

    const points = (qdrant.upsertExemplars as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Array<{
      vector: number[];
    }>;
    // Mock embedder returns vector[0] = i/N for input i. Verify the
    // upsert preserves this ordering (no out-of-order vector/text mismatch).
    for (let i = 0; i < points.length; i++) {
      const expected = i / Math.max(1, points.length);
      expect(points[i]?.vector[0], `vector at position ${i} should match its source text`).toBe(expected);
    }
  });
});

describe("seedExemplars — failure modes", () => {
  it("propagates embedder errors (caller is responsible for fail-soft)", async () => {
    const embedder: RouterEmbedder = {
      embedBatch: vi.fn().mockRejectedValue(new Error("Ollama down")),
      embedQuery: vi.fn(),
      probe: vi.fn(),
      model: "x",
      dim: 1024,
      url: "http://localhost",
    } as unknown as RouterEmbedder;
    const qdrant = mockQdrant(0);
    await expect(seedExemplars(embedder, qdrant, logger)).rejects.toThrow(/Ollama down/);
  });

  it("propagates Qdrant upsert errors", async () => {
    const embedder = mockEmbedder();
    const qdrant = {
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(0),
      upsertExemplars: vi.fn().mockRejectedValue(new Error("Qdrant write rejected")),
      search: vi.fn(),
    } as unknown as RouterQdrantClient;
    await expect(seedExemplars(embedder, qdrant, logger)).rejects.toThrow(
      /Qdrant write rejected/,
    );
  });

  it("throws if embedder returns wrong number of vectors", async () => {
    const embedder: RouterEmbedder = {
      embedBatch: vi.fn().mockResolvedValue([new Array(1024).fill(0)]), // only 1 vector
      embedQuery: vi.fn(),
      probe: vi.fn(),
      model: "x",
      dim: 1024,
      url: "http://localhost",
    } as unknown as RouterEmbedder;
    const qdrant = mockQdrant(0);
    await expect(seedExemplars(embedder, qdrant, logger)).rejects.toThrow(
      /returned 1 vectors for/,
    );
  });
});
