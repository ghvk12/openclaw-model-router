import type { ResolvedConfig } from "./config.js";
import type { HeuristicSignal, RoutingDecision } from "./classifier/types.js";

/**
 * Step 4 stub decider — always returns T1 (DEFAULT).
 *
 * Intentionally ignores the heuristic signal so the stub stays trivially
 * predictable. The signal IS still computed by `runHeuristics` upstream and
 * surfaced in the WAL row's `reason` field so audit logs can show what the
 * heuristic *would* have said even before the real decider is wired
 * (Step 6).
 *
 * This keeps the design's promise from DESIGN.md §15 step 4:
 *   "start logging from a stub decider that always returns T1.
 *    Now we can ship to dev and see real-traffic JSONL."
 *
 * The `cfg` parameter is unused today but kept on the signature so the swap
 * to `decideReal(prompt, signal, semantic, cfg)` in Step 6 is purely
 * additive — no call-site refactor.
 */
export function stubDecide(
  signal: HeuristicSignal,
  cfg: ResolvedConfig,
): RoutingDecision {
  // cfg is reserved for the real decider in Step 6; reference it once so
  // unused-param lint stays quiet without a `_cfg` rename that would also
  // ripple through the Step 6 swap.
  void cfg;
  return {
    tier: "T1",
    confidence: 0.5,
    classifiers: ["heuristic_default"],
    reason: stubReason(signal),
  };
}

/**
 * Compose a one-line audit reason that describes what the heuristic
 * detected, so even before the real decider lands operators can see
 * whether the heuristic agrees / disagrees with the always-T1 default.
 *
 * Output examples:
 *   "stub decider (always T1) — heuristic: neutral"
 *   "stub decider (always T1) — heuristic: trivial (trivial_short_no_question)"
 *   "stub decider (always T1) — heuristic: escalate (escalate_pattern_match:refactor, escalate_long_prompt)"
 *   "stub decider (always T1) — heuristic: trivial+escalate (trivial_pattern_match:thanks, escalate_pattern_match:refactor)"
 */
function stubReason(signal: HeuristicSignal): string {
  const tag = describeFlags(signal);
  if (signal.reasons.length === 0) {
    return `stub decider (always T1) — heuristic: ${tag}`;
  }
  const reasonStr = signal.reasons
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
  return `stub decider (always T1) — heuristic: ${tag} (${reasonStr})`;
}

function describeFlags(signal: HeuristicSignal): string {
  if (signal.trivial && signal.escalate) {
    return "trivial+escalate";
  }
  if (signal.trivial) {
    return "trivial";
  }
  if (signal.escalate) {
    return "escalate";
  }
  return "neutral";
}
