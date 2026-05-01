import type { Logger } from "../logger.js";
import {
  SEED_EXEMPLARS,
  SEED_EXEMPLARS_VERSION,
  type Exemplar,
} from "./exemplars.js";
import type { RouterEmbedder } from "./embedder.js";
import type { ExemplarUpsert, RouterQdrantClient } from "./qdrant-router.js";

/**
 * Bootstrap the Qdrant exemplar collection from `SEED_EXEMPLARS`.
 *
 * Idempotency contract:
 *   - Safe to call on every gateway_start. Skips the heavy
 *     embed+upsert path when the collection already holds at least
 *     `SEED_EXEMPLARS.length` points (the common case after first
 *     install).
 *   - Force-rebuilds when called with `{ force: true }`, e.g. from
 *     a future CLI command after the seed list changes.
 *   - Always uses deterministic exemplar ids (sha256 of tier+text), so
 *     even a non-skipped re-run overwrites the same point ids instead
 *     of producing duplicates.
 *
 * Failure mode: throws on Ollama/Qdrant outages. The caller (index.ts
 * gateway_start) catches and logs — bootstrap failure leaves the
 * semantic classifier disabled but does not crash the gateway. The
 * heuristic classifier still runs; the decider falls back to T1.
 */

export type SeedResult =
  /** Collection already had ≥ SEED_EXEMPLARS.length points; nothing was written. */
  | { status: "skipped"; existingCount: number; expected: number }
  /** Bootstrap succeeded; this many points were upserted. */
  | { status: "seeded"; pointsWritten: number; durationMs: number };

export type SeedOptions = {
  /** When true, bypass the count-check fast path and re-embed everything. */
  force?: boolean;
};

export async function seedExemplars(
  embedder: RouterEmbedder,
  qdrant: RouterQdrantClient,
  logger: Logger,
  opts: SeedOptions = {},
): Promise<SeedResult> {
  await qdrant.ensureCollection();

  if (!opts.force) {
    const existing = await qdrant.countPoints();
    const expected = SEED_EXEMPLARS.length;
    if (existing >= expected) {
      logger.info(
        `model-router: exemplar collection already seeded (${existing} ≥ ${expected} points) — skipping bootstrap`,
      );
      return { status: "skipped", existingCount: existing, expected };
    }
    logger.info(
      `model-router: exemplar collection has ${existing} points (< ${expected} expected) — running bootstrap`,
    );
  } else {
    logger.info(`model-router: force=true — re-running exemplar bootstrap`);
  }

  const t0 = performance.now();

  // Embed in batch. mxbai-embed-large is fast on a single GPU; ~60
  // exemplars complete in well under a second. We embed all at once
  // rather than per-batch chunks since the count is small and bounded
  // by the seed list size.
  const texts = SEED_EXEMPLARS.map((e) => e.text);
  const vectors = await embedder.embedBatch(texts);

  if (vectors.length !== SEED_EXEMPLARS.length) {
    throw new Error(
      `Embedder returned ${vectors.length} vectors for ${SEED_EXEMPLARS.length} exemplars`,
    );
  }

  const points: ExemplarUpsert[] = SEED_EXEMPLARS.map((exemplar, i) => ({
    id: exemplar.id,
    vector: vectors[i]!,
    payload: {
      text: exemplar.text,
      tier: exemplar.tier,
      source: exemplar.source,
      version: SEED_EXEMPLARS_VERSION,
    },
  }));

  await qdrant.upsertExemplars(points);

  const durationMs = performance.now() - t0;
  logger.info(
    `model-router: bootstrapped ${points.length} exemplars (T0:${countTier(SEED_EXEMPLARS, "T0")}, ` +
      `T1:${countTier(SEED_EXEMPLARS, "T1")}, T2:${countTier(SEED_EXEMPLARS, "T2")}) ` +
      `in ${durationMs.toFixed(0)}ms`,
  );
  return { status: "seeded", pointsWritten: points.length, durationMs };
}

function countTier(exemplars: readonly Exemplar[], tier: string): number {
  return exemplars.filter((e) => e.tier === tier).length;
}
