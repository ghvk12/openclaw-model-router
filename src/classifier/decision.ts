import type { ClassifierConfig, TierId } from "../config.js";
import { estimateTokens } from "../tokens.js";
import { runHeuristics } from "./heuristics.js";
import { runSemantic, type SemanticDeps } from "./semantic.js";
import type { HeuristicSignal, RoutingDecision, SemanticSignal } from "./types.js";

/**
 * Step 6 routing decider. Implements the precedence ladder from
 * DESIGN.md §5 exactly:
 *
 *   1. Hard escalations (deterministic, never overridden):
 *        - tokenCount > longContextThreshold       → T3
 *        - any image / video / audio attachment    → T3
 *      (Documents are NOT auto-T3 — they fit DeepSeek context.)
 *
 *   2. Heuristic fast path:
 *        - heuristic.escalate                       → T2 @ 0.85
 *
 *   3. Semantic disabled or unavailable (config off, bootstrap failed,
 *      or runtime call threw):
 *        - heuristic.trivial → T1 @ 0.60 (conservative — no semantic
 *          confirmation, so we don't downgrade to T0)
 *        - else              → T1 @ 0.50 (default)
 *
 *   4. Combine signals (semantic enabled and ran):
 *        - heuristic.trivial AND semantic.tier=T0 AND
 *          semantic.confidence>0.80                 → T0  (BOTH agree;
 *                                                          asymmetric-cost
 *                                                          rule satisfied)
 *        - priorTier set AND semantic.confidence <
 *          marginThreshold                          → priorTier
 *                                                    (sticky-prior bias)
 *        - semantic.tier === "T0" alone             → T1
 *                                                    (heuristic disagreed;
 *                                                    asymmetric-cost rule)
 *        - else                                     → semantic.tier
 *
 * Conservative-default policy (DESIGN.md §10): every uncertain branch
 * lands on T1 (DeepSeek Flash). Routing never silently demotes to T0
 * without two independent agreeing signals; never silently promotes to
 * T3 without a deterministic structural reason (long context or
 * multimodal). This is what makes a no-shadow-mode rollout safe.
 */

export type DecisionInput = {
  prompt: string;
  attachments?: ReadonlyArray<{ kind: string; mimeType?: string }>;
  /** Tier picked on the previous turn of this conversation, if known. */
  priorTier: TierId | null;
};

export type DecisionDeps = {
  /** Null when semantic is disabled in config OR bootstrap failed at
   *  gateway_start. The decider treats both as "no semantic available"
   *  and falls back to the conservative T1 default. */
  semantic: SemanticDeps | null;
};

export type DecisionTrace = {
  /** Heuristic signal computed on every request (cheap, pure). */
  heuristic: HeuristicSignal;
  /** Semantic signal — present only when the semantic path actually ran. */
  semantic?: SemanticSignal;
  /** Wall-clock spent in the entire decide() call. Includes heuristic +
   *  semantic + any I/O. Useful for tracking the <500ms loose budget. */
  totalLatencyMs: number;
};

export type DecisionOutcome = {
  decision: RoutingDecision;
  trace: DecisionTrace;
};

/** Asymmetric-cost confidence threshold for the BOTH-AGREE-ON-TRIVIAL
 *  rule. Only when the semantic classifier is THIS confident in T0 do
 *  we let the prompt reach the local model — otherwise the cost of
 *  Flash is small enough that we'd rather pay it than risk a bad answer
 *  from the local model. Hardcoded to keep the policy auditable; could
 *  be promoted to config later if production data justifies tuning. */
const SEMANTIC_T0_AGREEMENT_THRESHOLD = 0.80;

/** Multimodal kinds that force T3 (Gemini). Document attachments stay
 *  on the picked tier because they typically fit in DeepSeek's context. */
const MULTIMODAL_KINDS = new Set(["image", "video", "audio"]);

export async function decide(
  input: DecisionInput,
  cfg: ClassifierConfig,
  deps: DecisionDeps,
): Promise<DecisionOutcome> {
  const t0 = performance.now();

  // ── 1. HARD ESCALATIONS ─────────────────────────────────────────────
  const tokenCount = estimateTokens(input.prompt);
  if (tokenCount > cfg.longContextThreshold) {
    return finalize(
      {
        tier: "T3",
        confidence: 1.0,
        classifiers: ["long_context_override"],
        reason: `tokenCount≈${tokenCount} > longContextThreshold=${cfg.longContextThreshold}`,
      },
      { heuristic: emptyHeuristicSignal() },
      t0,
    );
  }

  const multimodalKinds = (input.attachments ?? [])
    .map((a) => a.kind)
    .filter((k) => MULTIMODAL_KINDS.has(k));
  if (multimodalKinds.length > 0) {
    return finalize(
      {
        tier: "T3",
        confidence: 1.0,
        classifiers: ["multimodal_override"],
        reason: `attachments=${multimodalKinds.join(",")}`,
      },
      { heuristic: emptyHeuristicSignal() },
      t0,
    );
  }

  // ── 2. HEURISTIC FAST PATH ──────────────────────────────────────────
  const heuristic = runHeuristics(input.prompt, cfg.heuristics);
  if (heuristic.escalate) {
    return finalize(
      {
        tier: "T2",
        confidence: 0.85,
        classifiers: ["heuristic_escalate"],
        reason: `heuristic escalate: ${formatHeuristicReasons(heuristic)}`,
      },
      { heuristic },
      t0,
    );
  }

  // ── 3. SEMANTIC DISABLED OR UNAVAILABLE ─────────────────────────────
  if (!cfg.semantic.enabled || deps.semantic === null) {
    if (heuristic.trivial) {
      return finalize(
        {
          tier: "T1",
          confidence: 0.6,
          classifiers: ["heuristic_trivial", "no_semantic"],
          reason: `heuristic trivial (${formatHeuristicReasons(heuristic)}) but no semantic confirmation → conservative T1`,
        },
        { heuristic },
        t0,
      );
    }
    return finalize(
      {
        tier: "T1",
        confidence: 0.5,
        classifiers: ["no_semantic"],
        reason: `no escalate; no semantic available → default T1`,
      },
      { heuristic },
      t0,
    );
  }

  // ── 4. SEMANTIC PATH (with try/catch fail-soft) ─────────────────────
  let semantic: SemanticSignal;
  try {
    semantic = await runSemantic(
      input.prompt,
      cfg.semantic,
      deps.semantic,
      input.priorTier,
    );
  } catch (err) {
    // Semantic call threw at runtime (Qdrant unreachable, Ollama
    // timeout, etc.). Fall back to the conservative default rather
    // than failing the request. Operators see this in WAL audit logs;
    // a recurring "semantic_failed" pattern signals an outage.
    return finalize(
      {
        tier: "T1",
        confidence: 0.45,
        classifiers: ["semantic_failed"],
        reason: `semantic classifier failed at runtime: ${truncate(String(err), 100)} → fallback T1`,
      },
      { heuristic },
      t0,
    );
  }

  // ── 5. COMBINE SIGNALS ──────────────────────────────────────────────
  // Both signals agree on trivial AND semantic is confident → T0.
  // The asymmetric-cost rule: only the cheapest tier requires the
  // strictest evidence (both signals + high confidence) because a wrong
  // T0 routing affects answer quality where it's most expensive (the
  // local model is the weakest LLM in the stack).
  if (
    heuristic.trivial &&
    semantic.tier === "T0" &&
    semantic.confidence > SEMANTIC_T0_AGREEMENT_THRESHOLD
  ) {
    return finalize(
      {
        tier: "T0",
        confidence: Math.min(semantic.confidence, 0.95),
        classifiers: ["heuristic_trivial", "semantic_T0"],
        reason: `both signals agree on trivial; topExemplars=[${formatExemplars(semantic)}]`,
      },
      { heuristic, semantic },
      t0,
    );
  }

  // Sticky-prior bias: when the semantic margin is too thin to trust,
  // prefer continuity with the previous turn's tier. This stops
  // alternating-tier flapping in long conversations where each turn is
  // semantically borderline.
  if (
    input.priorTier !== null &&
    semantic.confidence < cfg.semantic.marginThreshold
  ) {
    return finalize(
      {
        tier: input.priorTier,
        confidence: 0.55,
        classifiers: ["sticky_prior"],
        reason: `low semantic margin (${semantic.confidence.toFixed(3)} < ${cfg.semantic.marginThreshold}) → keep prior tier ${input.priorTier}`,
      },
      { heuristic, semantic },
      t0,
    );
  }

  // Semantic alone said T0 but heuristic is neutral → don't trust the
  // single signal for the cheapest tier. Asymmetric-cost rule again.
  if (semantic.tier === "T0") {
    return finalize(
      {
        tier: "T1",
        confidence: 0.5,
        classifiers: ["semantic_T0", "heuristic_disagreed"],
        reason: `semantic said T0 (confidence=${semantic.confidence.toFixed(3)}) but heuristic neutral → conservative T1`,
      },
      { heuristic, semantic },
      t0,
    );
  }

  // Otherwise honor the semantic decision.
  return finalize(
    {
      tier: semantic.tier,
      confidence: semantic.confidence,
      classifiers: ["semantic", semanticTierLabel(semantic.tier)],
      reason: `semantic ${semantic.tier} @ ${semantic.confidence.toFixed(3)}; topExemplars=[${formatExemplars(semantic)}]`,
    },
    { heuristic, semantic },
    t0,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────

function finalize(
  decision: RoutingDecision,
  trace: { heuristic: HeuristicSignal; semantic?: SemanticSignal },
  t0: number,
): DecisionOutcome {
  return {
    decision,
    trace: {
      heuristic: trace.heuristic,
      ...(trace.semantic !== undefined ? { semantic: trace.semantic } : {}),
      totalLatencyMs: performance.now() - t0,
    },
  };
}

function emptyHeuristicSignal(): HeuristicSignal {
  // Used only by the hard-escalation paths that bypass the heuristic
  // computation entirely. WAL still gets a structurally-valid signal
  // (so audit code can grep on `trace.heuristic.reasons` without
  // null-checks) — it's just empty.
  return { trivial: false, escalate: false, reasons: [], promptChars: 0 };
}

function formatHeuristicReasons(h: HeuristicSignal): string {
  if (h.reasons.length === 0) {
    return "none";
  }
  return h.reasons
    .map((r) => {
      switch (r.kind) {
        case "trivial_pattern_match":
        case "escalate_pattern_match":
          return `${r.kind}:${r.matched}`;
        default:
          return r.kind;
      }
    })
    .join(", ");
}

function formatExemplars(s: SemanticSignal): string {
  return s.topExemplars.slice(0, 3).join("; ");
}

function semanticTierLabel(tier: TierId): "semantic_T0" | "semantic_T1" | "semantic_T2" | "semantic_T3" {
  return `semantic_${tier}` as const;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}
