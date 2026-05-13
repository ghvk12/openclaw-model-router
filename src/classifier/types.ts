import type { TierId } from "../config.js";

/**
 * Shared classifier types. Lives in its own module so:
 *   - heuristics.ts (Step 3, pure)
 *   - semantic.ts (Step 5, I/O-bound)
 *   - decision.ts (Step 6, orchestrator)
 *   - decision-wal.ts (Step 4, audit)
 * can all import from one place without creating a circular dependency
 * triangle (decision <-> heuristics <-> semantic).
 */

/**
 * Why a heuristic signal fired. Stored in the WAL so an operator running
 * `openclaw model-router audit ...` can answer "why did the classifier
 * call this prompt trivial?" by reading one line.
 *
 * `pattern` and `matched` are kept short on purpose — patterns are usually
 * \\b-delimited keyword regexes (≤30 chars) and the matched substring is
 * truncated to 40 chars. Full prompt text is never stored in the WAL.
 */
export type HeuristicReason =
  | { kind: "trivial_short_no_question"; promptChars: number }
  | { kind: "trivial_pattern_match"; pattern: string; matched: string }
  | { kind: "escalate_pattern_match"; pattern: string; matched: string }
  | { kind: "escalate_long_prompt"; promptChars: number }
  | { kind: "escalate_code_density"; pathHits: number; callHits: number };

/**
 * Output of `runHeuristics(prompt, cfg)`. Both `trivial` and `escalate` can
 * be true simultaneously (e.g. "thanks! refactor foo.ts please") — the
 * decision orchestrator (Step 6) resolves the tie by precedence: escalate
 * always wins (DESIGN.md §5 — we'd rather over-spend on Pro than
 * under-serve a real ask).
 *
 * `reasons` is ordered by detection sequence; first reason in each kind
 * suffices for a true outcome (we don't enumerate all matches — just the
 * first hit is recorded for the WAL).
 */
export type HeuristicSignal = {
  trivial: boolean;
  escalate: boolean;
  reasons: HeuristicReason[];
  promptChars: number;
};

/**
 * Output of the semantic classifier (Step 5). Stub now so the decision
 * orchestrator can be unit-tested before Qdrant is wired.
 *
 * `confidence` is the margin between top-1 and top-2 vote weights —
 * compared against `classifier.semantic.marginThreshold` in decision.ts.
 *
 * `topExemplars` is opaque text (exemplar id strings, not raw prompt
 * text) used for the WAL "reason" field.
 */
export type SemanticSignal = {
  tier: TierId;
  confidence: number;
  topExemplars: string[];
  /**
   * Wall-clock embedding + Qdrant kNN time. Useful for tracking the
   * classifier latency budget (<500ms loose budget per DESIGN.md §6).
   */
  latencyMs: number;
};

/**
 * Final decision the router hands to OpenClaw. Composed by decision.ts
 * from heuristic + semantic signals + the long-context override.
 */
export type RoutingDecision = {
  tier: TierId;
  confidence: number;
  classifiers: ClassifierLabel[];
  reason: string;
};

/**
 * Provenance label set used in `RoutingDecision.classifiers`. Stable
 * strings so the WAL is grep-friendly across releases — adding a new
 * label requires bumping the WAL schema version (Step 4).
 *
 * Label semantics:
 *   heuristic_trivial         — heuristic flagged the prompt as trivial.
 *   heuristic_escalate        — heuristic flagged the prompt as escalate.
 *   heuristic_default         — Step 4 stub label only; superseded in Step 6.
 *   heuristic_disagreed       — semantic said T0 but heuristic was neutral
 *                               (asymmetric-cost rule kept us at T1).
 *   semantic                  — final tier honors the semantic classifier
 *                               (no boost, no override).
 *   semantic_T0               — semantic vote landed on T0 specifically;
 *                               combined with heuristic_trivial when both
 *                               agree on trivial.
 *   semantic_T1, _T2, _T3     — reserved for finer-grained semantic
 *                               provenance; not all are emitted in v0.1.
 *   semantic_failed           — runSemantic threw at request time
 *                               (Qdrant/Ollama outage); fell back to T1.
 *   no_semantic               — semantic classifier wasn't available
 *                               (config disabled OR bootstrap failed).
 *   sticky_prior              — kept the previous turn's tier because the
 *                               semantic margin was below marginThreshold.
 *   long_context_override     — token count exceeded longContextThreshold,
 *                               forced to T3 (deterministic, never overridden).
 *   multimodal_override       — image/video/audio attachment forced T3.
 *   failover_substitute       — Step 8 substituted a different tier than
 *                               the decider chose due to a circuit-breaker.
 */
export type ClassifierLabel =
  | "heuristic_trivial"
  | "heuristic_escalate"
  | "heuristic_default"
  | "heuristic_disagreed"
  | "semantic"
  | "semantic_T0"
  | "semantic_T1"
  | "semantic_T2"
  | "semantic_T3"
  | "semantic_failed"
  | "no_semantic"
  | "sticky_prior"
  | "long_context_override"
  | "multimodal_override"
  | "failover_substitute";
