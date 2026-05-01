import type { SemanticConfig, TierId } from "../config.js";
import type { RouterEmbedder } from "./embedder.js";
import type { ExemplarHit, RouterQdrantClient } from "./qdrant-router.js";
import type { SemanticSignal } from "./types.js";

/**
 * Tier-1 semantic classifier — embed prompt → ANN search exemplars →
 * weighted vote → tier + confidence.
 *
 * Algorithm (DESIGN.md §5 "Semantic kNN"):
 *   1. Embed prompt via `mxbai-embed-large` (Ollama).
 *   2. Search top-K exemplars by cosine similarity.
 *   3. Weighted vote: each exemplar contributes `similarity * 1.0` to
 *      its tier.
 *   4. Sticky prior boost: if `priorTier` appears in top-3, multiply
 *      its vote weight by `stickyPriorBoost`.
 *   5. `tier = argmax(votes); confidence = (top - second) / top`.
 *
 * Dependencies are injected so unit tests can run with mocked
 * embedder/qdrant clients without touching the network.
 */

export type SemanticDeps = {
  embedder: RouterEmbedder;
  qdrant: RouterQdrantClient;
};

/**
 * Run the semantic classifier. Returns the winning tier with a
 * confidence score in [0, 1] (margin between top-1 and top-2 vote
 * weights). T3 is intentionally unreachable from this classifier
 * (DESIGN.md §5: "T3 is never chosen by semantic kNN" — only via the
 * hard escalation rules in decision.ts).
 *
 * Caller responsibilities:
 *   - Decide whether to call this at all (skip if heuristic is decisive
 *     or if `cfg.enabled === false`).
 *   - Pass `priorTier` from conversation state if available; pass `null`
 *     otherwise (cold conversations skip the sticky-prior boost).
 *   - Handle errors — a Qdrant outage or Ollama timeout throws here;
 *     decision.ts (Step 6) wraps this call in try/catch and falls back
 *     to T1 on failure (the conservative default).
 */
export async function runSemantic(
  prompt: string,
  cfg: SemanticConfig,
  deps: SemanticDeps,
  priorTier: TierId | null = null,
): Promise<SemanticSignal> {
  const t0 = performance.now();
  const queryVec = await deps.embedder.embedQuery(prompt);
  const hits = await deps.qdrant.search(queryVec, cfg.topK);
  const aggregated = aggregateVotes(hits, cfg.stickyPriorBoost, priorTier);
  return {
    tier: aggregated.tier,
    confidence: aggregated.confidence,
    topExemplars: hits.map((h) => exemplarSnippet(h.payload.text)),
    latencyMs: performance.now() - t0,
  };
}

/**
 * Pure vote-aggregation logic. Exposed for unit tests so we can verify
 * the algorithm without spinning up Qdrant or Ollama.
 *
 * Returns the winning tier and a confidence score:
 *   - confidence = (top_vote - second_vote) / top_vote, clamped to [0, 1]
 *   - tier defaults to T1 (the conservative default) when no hits are
 *     returned — keeps behavior aligned with DESIGN.md §3.1's
 *     "default to T1 under uncertainty" promise.
 */
export function aggregateVotes(
  hits: readonly ExemplarHit[],
  stickyPriorBoost: number,
  priorTier: TierId | null,
): { tier: TierId; confidence: number } {
  if (hits.length === 0) {
    return { tier: "T1", confidence: 0 };
  }

  const votes = new Map<TierId, number>();
  hits.forEach((hit, idx) => {
    const baseWeight = hit.score;
    // Sticky prior boost — only when priorTier appears in the top-3
    // hits AND matches this hit's tier. Top-3 (not top-K) keeps the
    // boost from leaking down low-similarity tail hits.
    const inTopThree = idx < 3;
    const stickyMatch = priorTier !== null && hit.payload.tier === priorTier;
    const weight = inTopThree && stickyMatch ? baseWeight * stickyPriorBoost : baseWeight;
    votes.set(hit.payload.tier, (votes.get(hit.payload.tier) ?? 0) + weight);
  });

  const sorted = [...votes.entries()].sort(([, a], [, b]) => b - a);
  const top = sorted[0];
  if (!top) {
    return { tier: "T1", confidence: 0 };
  }
  const [topTier, topVote] = top;
  const secondVote = sorted[1]?.[1] ?? 0;
  const confidence = topVote > 0 ? Math.min(1, Math.max(0, (topVote - secondVote) / topVote)) : 0;
  return { tier: topTier, confidence };
}

/**
 * Truncate exemplar text for the WAL `topExemplars` field. Keeps audit
 * rows small and removes any chance of leaking long exemplar bodies
 * into logs.
 */
function exemplarSnippet(text: string): string {
  const MAX = 60;
  return text.length <= MAX ? text : text.slice(0, MAX) + "…";
}
