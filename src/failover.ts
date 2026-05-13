import type { ResolvedConfig, TierConfig, TierId, FailoverConfig } from "./config.js";

/**
 * Step 8 — failover, circuit breaker, and substitution.
 *
 * Background (the bug this module fixes — see DESIGN.md §16.12 / §6):
 *   The gateway's model failover chain re-invokes `before_model_resolve` for
 *   EVERY candidate it tries, not just the first. Pre-Step-8 our hook
 *   unconditionally returned the same `{modelOverride, providerOverride}`
 *   for the originally-decided tier — even on retry. Net result: when the
 *   primary tier (e.g. T2 = google/gemini-3.1-pro-preview) hit a 429, the
 *   gateway tried failover candidates (deepseek-chat, deepseek-reasoner),
 *   but our hook FORCED each candidate back to the broken google override.
 *   All three attempts went to the same broken provider, and the user saw
 *   "All Models are temporarily rate-limited" with zero substitution.
 *
 * Step 8 closes that loop with two cooperating mechanisms:
 *
 *   1. REACTIVE substitution (`RunAttemptTracker` + `substituteTier`).
 *      Tracks attempts per agent `runId`. On a re-invocation of
 *      `before_model_resolve` for the same runId, we KNOW the previous
 *      attempt failed (gateway wouldn't re-invoke otherwise). Substitute
 *      to the next tier in the always-promote-never-demote-then-fallback
 *      ladder — so retry attempts actually go somewhere different.
 *      This is the primary fix for the user's WhatsApp outage.
 *
 *   2. PROACTIVE substitution (`CircuitBreaker`). Tracks cross-runId
 *      failure rates per `provider/model` key. After N consecutive
 *      failures (or rate >= threshold) within a window, opens the breaker
 *      for that key — `substituteTier` then routes around it on FIRST
 *      attempt without paying the cost of a definitely-failing call.
 *      Half-open after `cooldownMs` to probe recovery.
 *      The breaker is wired up in Step 8 but its feed-loop (subscribing
 *      to outcome hooks like `model_call_ended` or `agent_end`) is
 *      deferred — those hooks have version-skew issues with the current
 *      runtime (see DESIGN.md §11). For Step 8 v1 the breaker exists,
 *      defaults to "all closed", and is consulted by `substituteTier`
 *      so the proactive path lights up for free once outcome feeds
 *      land.
 *
 * Substitution policy (DESIGN.md §6 — minimum-movement, fail-soft):
 *   - T0 broken/attempted → T1 (escalate)
 *   - T1 broken/attempted → T2 (escalate)
 *   - T2 broken/attempted → T1 (de-escalate; T1 is cheaper and more
 *     reliable than escalating to T3 which is the most expensive tier)
 *   - T3 broken/attempted → T2 (de-escalate)
 *   - All four tiers exhausted → return `undefined` so the gateway
 *     falls back to its own default chain (no override emitted)
 *
 * All classes/functions in this module are PURE (no I/O) so they can
 * be unit-tested deterministically. The hook integration in
 * `src/index.ts` is responsible for wiring them into the runtime.
 */

/* ------------------------------------------------------------------- */
/* RunAttemptTracker                                                    */
/* ------------------------------------------------------------------- */

/**
 * One recorded attempt in a single agent run. We track tier (so we know
 * which slot to advance past on retry) AND modelKey (so the proactive
 * breaker has the same join key when it eventually consumes outcomes).
 */
export type RunAttempt = {
  tier: TierId;
  modelKey: string; // "provider/model"
  ts: number; // ms
};

/**
 * Bounded per-runId attempt log. Lives in-memory only; on process restart
 * the gateway will issue fresh runIds so there's nothing to persist.
 *
 * Bounded via `maxRuns` (LRU-ish — oldest runId dropped on overflow) and
 * `runTtlMs` (entries older than TTL are eligible for cleanup on next
 * touch). Both bounds keep memory predictable across many concurrent
 * sessions even if individual runs leak (e.g. agent crash mid-failover).
 */
export class RunAttemptTracker {
  private readonly attempts = new Map<string, RunAttempt[]>();
  private readonly maxRuns: number;
  private readonly runTtlMs: number;

  constructor(opts: { maxRuns?: number; runTtlMs?: number } = {}) {
    this.maxRuns = opts.maxRuns ?? 1024;
    this.runTtlMs = opts.runTtlMs ?? 5 * 60 * 1000; // 5 min
  }

  /**
   * Record an attempt for `runId`. If the runId is unknown, allocate a
   * new entry (and trim oldest if at capacity). The hot path stays O(1)
   * via Map.delete+set for LRU positioning.
   */
  record(runId: string, attempt: RunAttempt): void {
    if (!runId) {
      return; // nothing to correlate against; silently drop
    }
    const existing = this.attempts.get(runId);
    if (existing) {
      this.attempts.delete(runId); // refresh LRU position
      existing.push(attempt);
      this.attempts.set(runId, existing);
      return;
    }
    if (this.attempts.size >= this.maxRuns) {
      // Drop the oldest entry — the first key in insertion order.
      const oldest = this.attempts.keys().next().value;
      if (oldest !== undefined) {
        this.attempts.delete(oldest);
      }
    }
    this.attempts.set(runId, [attempt]);
  }

  /**
   * Return the priors for `runId`, optionally filtered to entries
   * within `runTtlMs`. Returns a defensive copy — callers may mutate.
   *
   * Empty array (not undefined) for unknown runIds keeps the call site
   * branch-free.
   */
  priors(runId: string, nowMs: number = Date.now()): RunAttempt[] {
    if (!runId) {
      return [];
    }
    const entries = this.attempts.get(runId);
    if (!entries || entries.length === 0) {
      return [];
    }
    const cutoff = nowMs - this.runTtlMs;
    const fresh = entries.filter((e) => e.ts >= cutoff);
    if (fresh.length !== entries.length) {
      // Drop stale and update map. If everything is stale, drop the run.
      if (fresh.length === 0) {
        this.attempts.delete(runId);
      } else {
        this.attempts.set(runId, fresh);
      }
    }
    return fresh.slice();
  }

  /**
   * Test/observability helper — current runId count (post-TTL trim is
   * lazy on access so this includes stale entries until they're touched).
   */
  size(): number {
    return this.attempts.size;
  }

  /**
   * Forget everything. Used in tests and (eventually) on `gateway_stop`.
   */
  clear(): void {
    this.attempts.clear();
  }
}

/* ------------------------------------------------------------------- */
/* CircuitBreaker                                                       */
/* ------------------------------------------------------------------- */

export type CircuitState = "closed" | "open" | "half_open";

/**
 * Failure event recorded against a `provider/model` key. `kind` is a
 * coarse classification used by the breaker's threshold logic; the
 * detailed error string isn't carried since the breaker's job is
 * trip/recover, not diagnosis.
 */
export type CircuitFailureKind = "rate_limit" | "quota" | "5xx" | "auth" | "other";

type FailureEvent = { ts: number; kind: CircuitFailureKind };

type BreakerEntry = {
  state: CircuitState;
  failures: FailureEvent[]; // most recent first; trimmed to windowSize
  consecutiveFailures: number;
  openedAt?: number;
};

/**
 * Per-`provider/model` circuit breaker.
 *
 * State machine:
 *   - CLOSED:    calls pass through; failures recorded
 *   - OPEN:      calls short-circuited (`canCall()` returns false);
 *                no calls reach the provider until cooldownMs elapses
 *   - HALF_OPEN: a single probe call is allowed; success → CLOSED,
 *                failure → OPEN with fresh openedAt
 *
 * Trip condition (Step 8 v1 — consecutive-only):
 *   - `consecutiveFailures >= consecutiveFailureThreshold`
 *
 * The `errorRateThreshold` config field is reserved for a v2 enhancement
 * that tracks both successes and failures in a sliding time window. The
 * v1 implementation is intentionally simpler: a consecutive-failure
 * counter that resets on any success. This catches the dominant failure
 * mode (rate_limit / quota — bursts of identical errors) without the
 * complexity (and false-positive surface) of rate-window math.
 * `windowSize` still bounds the in-memory failure log for observability.
 *
 * The breaker is best-effort — feed it failures via `recordFailure()`
 * and successes via `recordSuccess()`. The Step 8 v1 ships the breaker
 * but does NOT wire automatic feeding (no outcome hook stable across
 * runtime versions yet). `substituteTier` consults `canCall()` so the
 * proactive path lights up the moment a future step wires the feed.
 */
export class CircuitBreaker {
  private readonly cfg: FailoverConfig;
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(cfg: FailoverConfig) {
    this.cfg = cfg;
  }

  /**
   * `canCall` — should we allow a call to this provider/model right now?
   *
   * This is the only method `substituteTier` reads. Side effect: a key in
   * OPEN state automatically transitions to HALF_OPEN once `cooldownMs`
   * has elapsed since `openedAt`. The transition happens HERE rather
   * than on a timer so the breaker doesn't need a background process.
   */
  canCall(modelKey: string, nowMs: number = Date.now()): boolean {
    const entry = this.entries.get(modelKey);
    if (!entry) {
      return true; // no history → CLOSED
    }
    if (entry.state === "open") {
      if (entry.openedAt !== undefined && nowMs - entry.openedAt >= this.cfg.cooldownMs) {
        entry.state = "half_open";
        return true; // probe call allowed
      }
      return false;
    }
    // closed and half_open both allow calls
    return true;
  }

  /**
   * `state` — observability accessor. Same lazy half_open transition as
   * `canCall` so callers see consistent state.
   */
  state(modelKey: string, nowMs: number = Date.now()): CircuitState {
    const entry = this.entries.get(modelKey);
    if (!entry) {
      return "closed";
    }
    if (entry.state === "open" && entry.openedAt !== undefined && nowMs - entry.openedAt >= this.cfg.cooldownMs) {
      entry.state = "half_open";
    }
    return entry.state;
  }

  /**
   * Record a failure event for `modelKey`. May trip the breaker.
   * Returns the post-record state so callers can log breaker openings.
   */
  recordFailure(modelKey: string, kind: CircuitFailureKind, nowMs: number = Date.now()): CircuitState {
    const entry = this.ensureEntry(modelKey);
    entry.consecutiveFailures += 1;
    entry.failures.unshift({ ts: nowMs, kind });
    if (entry.failures.length > this.cfg.windowSize) {
      entry.failures.length = this.cfg.windowSize;
    }
    if (this.shouldTrip(entry)) {
      entry.state = "open";
      entry.openedAt = nowMs;
    }
    return entry.state;
  }

  /**
   * Record a success. Resets `consecutiveFailures` and, if the breaker
   * was HALF_OPEN, transitions back to CLOSED. The window of historical
   * failures is intentionally NOT cleared — recent error rate stays
   * measurable so we don't oscillate on an unstable provider.
   */
  recordSuccess(modelKey: string, nowMs: number = Date.now()): CircuitState {
    const entry = this.entries.get(modelKey);
    if (!entry) {
      return "closed";
    }
    entry.consecutiveFailures = 0;
    if (entry.state === "half_open") {
      entry.state = "closed";
      entry.openedAt = undefined;
    }
    // CLOSED stays CLOSED; OPEN stays OPEN until cooldown
    if (entry.state === "open" && entry.openedAt !== undefined && nowMs - entry.openedAt >= this.cfg.cooldownMs) {
      entry.state = "half_open";
    }
    return entry.state;
  }

  /**
   * Test/observability — return all known keys. Useful for the Step 9
   * audit CLI to dump current breaker state.
   */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Reset all state. Used in tests and (eventually) on operator CLI. */
  reset(): void {
    this.entries.clear();
  }

  private ensureEntry(modelKey: string): BreakerEntry {
    let entry = this.entries.get(modelKey);
    if (!entry) {
      entry = { state: "closed", failures: [], consecutiveFailures: 0 };
      this.entries.set(modelKey, entry);
    }
    return entry;
  }

  private shouldTrip(entry: BreakerEntry): boolean {
    return entry.consecutiveFailures >= this.cfg.consecutiveFailureThreshold;
  }
}

/* ------------------------------------------------------------------- */
/* Substitution                                                          */
/* ------------------------------------------------------------------- */

/**
 * Always-promote-never-demote-then-fallback ladder per DESIGN.md §6.
 * Indexed by source tier; each entry is the ordered list of substitution
 * candidates to try if the source is unavailable.
 *
 *   T0 unavailable → try T1 (escalate, only useful step up)
 *   T1 unavailable → try T2 (escalate to richer reasoning)
 *   T2 unavailable → try T1 (de-escalate; T1 is cheaper than T3 and
 *                            usually a better reliability bet than
 *                            escalating to the most expensive tier)
 *   T3 unavailable → try T2 (de-escalate)
 *
 * After the first candidate fails too, we try the next-in-ladder as a
 * last resort. Eventually we exhaust all four tiers — at that point
 * `substituteTier` returns `undefined` and the hook should return
 * `undefined` to let the gateway use its own default chain.
 */
export const SUBSTITUTION_LADDER: Record<TierId, readonly TierId[]> = {
  T0: ["T1", "T2", "T3"],
  T1: ["T2", "T0", "T3"],
  T2: ["T1", "T3", "T0"],
  T3: ["T2", "T1", "T0"],
} as const;

export type SubstitutionResult = {
  /** Final tier to route to. `null` means: no healthy tier left, return
   *  `undefined` from the hook so the gateway picks its own default. */
  tier: TierId | null;
  /** Was substitution actually applied (decided tier !== returned tier)? */
  applied: boolean;
  /**
   * Human-readable trail used in logs and the WAL `reason` field.
   * Empty string when no substitution applied.
   */
  reason: string;
};

/**
 * Build the `provider/model` join key the breaker uses. Pure helper —
 * exported so callers can construct the same key when feeding outcomes
 * into the breaker from a future hook.
 */
export function modelKeyOf(tier: TierConfig): string {
  return `${tier.provider}/${tier.model}`;
}

/**
 * Substitute `decidedTier` if either:
 *   1. The tier was already attempted in this run (`priors` contains it)
 *   2. The breaker for the tier's `provider/model` is OPEN
 *
 * Walks `SUBSTITUTION_LADDER[decidedTier]` looking for the first tier
 * that satisfies BOTH conditions: not in priors AND breaker not OPEN.
 * If no such tier exists, returns `{ tier: null, applied: true }` — the
 * hook then returns `undefined` to fully delegate to the gateway.
 *
 * Pure function. No side effects on `priors` or `breaker`.
 */
export function substituteTier(
  decidedTier: TierId,
  cfg: ResolvedConfig,
  priors: readonly RunAttempt[],
  breaker: CircuitBreaker,
  nowMs: number = Date.now(),
): SubstitutionResult {
  const decidedKey = modelKeyOf(cfg.tiers[decidedTier]);
  const triedTiers = new Set(priors.map((p) => p.tier));
  const decidedAttempted = triedTiers.has(decidedTier);
  const decidedOpen = !breaker.canCall(decidedKey, nowMs);

  if (!decidedAttempted && !decidedOpen) {
    // Happy path — no substitution needed.
    return { tier: decidedTier, applied: false, reason: "" };
  }

  // Why we're substituting — drives the WAL reason field.
  const triggers: string[] = [];
  if (decidedAttempted) {
    triggers.push(`already_attempted_in_run`);
  }
  if (decidedOpen) {
    triggers.push(`circuit_open(${decidedKey})`);
  }
  const trigger = triggers.join(",");

  for (const candidate of SUBSTITUTION_LADDER[decidedTier]) {
    if (triedTiers.has(candidate)) {
      continue;
    }
    const candidateKey = modelKeyOf(cfg.tiers[candidate]);
    if (!breaker.canCall(candidateKey, nowMs)) {
      continue;
    }
    return {
      tier: candidate,
      applied: true,
      reason: `failover ${decidedTier}→${candidate} (${trigger})`,
    };
  }

  // Every tier exhausted — surrender to gateway default.
  return {
    tier: null,
    applied: true,
    reason: `failover ${decidedTier}→none (${trigger}; all tiers exhausted)`,
  };
}
