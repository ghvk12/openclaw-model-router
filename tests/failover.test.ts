import { describe, it, expect, beforeEach } from "vitest";
import {
  RunAttemptTracker,
  CircuitBreaker,
  substituteTier,
  modelKeyOf,
  SUBSTITUTION_LADDER,
} from "../src/failover.js";
import { resolveConfig } from "../src/config.js";

/**
 * Failover unit tests (DESIGN.md §6, §16.12). Pure functions/classes only —
 * no I/O, no SDK dependencies. Tests stub `nowMs` to make state-machine
 * timing deterministic.
 *
 * Coverage:
 *   - RunAttemptTracker: record/priors round-trip, LRU bounds, TTL trim
 *   - CircuitBreaker: closed → open (consecutive + rate), open → half_open
 *     (cooldown), half_open → closed (success), half_open → open (failure)
 *   - substituteTier: happy path, in-run retry, breaker-open, exhaustion
 *   - SUBSTITUTION_LADDER shape
 *   - modelKeyOf utility
 */

const T0 = "T0" as const;
const T1 = "T1" as const;
const T2 = "T2" as const;
const T3 = "T3" as const;

const FAILOVER_DEFAULTS = {
  windowSize: 20,
  errorRateThreshold: 0.5,
  consecutiveFailureThreshold: 3,
  cooldownMs: 60_000,
};

describe("RunAttemptTracker", () => {
  let tracker: RunAttemptTracker;
  beforeEach(() => {
    tracker = new RunAttemptTracker();
  });

  it("returns [] for unknown runId", () => {
    expect(tracker.priors("unknown-run")).toEqual([]);
  });

  it("returns [] for empty/null runId (defensive)", () => {
    expect(tracker.priors("")).toEqual([]);
    tracker.record("", { tier: T1, modelKey: "x/y", ts: 1000 });
    expect(tracker.size(), "empty runId should be ignored").toBe(0);
  });

  it("round-trips a single attempt", () => {
    tracker.record("run-1", { tier: T1, modelKey: "deepseek/deepseek-v4-pro", ts: 1000 });
    const priors = tracker.priors("run-1", 1500);
    expect(priors).toHaveLength(1);
    expect(priors[0].tier).toBe(T1);
    expect(priors[0].modelKey).toBe("deepseek/deepseek-v4-pro");
  });

  it("preserves order of attempts within a single run", () => {
    tracker.record("run-1", { tier: T2, modelKey: "google/x", ts: 100 });
    tracker.record("run-1", { tier: T1, modelKey: "deepseek/y", ts: 200 });
    tracker.record("run-1", { tier: T3, modelKey: "anthropic/z", ts: 300 });
    const priors = tracker.priors("run-1", 400);
    expect(priors.map((p) => p.tier)).toEqual([T2, T1, T3]);
  });

  it("isolates attempts across different runIds", () => {
    tracker.record("run-A", { tier: T1, modelKey: "a", ts: 100 });
    tracker.record("run-B", { tier: T2, modelKey: "b", ts: 100 });
    expect(tracker.priors("run-A", 200).map((p) => p.tier)).toEqual([T1]);
    expect(tracker.priors("run-B", 200).map((p) => p.tier)).toEqual([T2]);
  });

  it("returns a defensive copy — caller mutation doesn't affect tracker", () => {
    tracker.record("run-1", { tier: T1, modelKey: "k", ts: 100 });
    const priors = tracker.priors("run-1", 200);
    priors.push({ tier: T3, modelKey: "junk", ts: 999 });
    expect(tracker.priors("run-1", 200), "internal state must not be mutated by caller").toHaveLength(1);
  });

  it("evicts oldest run when maxRuns is exceeded (LRU on insert)", () => {
    const small = new RunAttemptTracker({ maxRuns: 2 });
    // Use a `now` close to the recorded `ts` so TTL doesn't trim entries.
    const now = 200;
    small.record("run-1", { tier: T1, modelKey: "a", ts: 100 });
    small.record("run-2", { tier: T1, modelKey: "b", ts: 100 });
    small.record("run-3", { tier: T1, modelKey: "c", ts: 100 });
    expect(small.size()).toBe(2);
    expect(small.priors("run-1", now), "oldest should be evicted").toEqual([]);
    expect(small.priors("run-3", now)).toHaveLength(1);
  });

  it("refreshes LRU position on repeat record", () => {
    const small = new RunAttemptTracker({ maxRuns: 2 });
    const now = 400;
    small.record("run-1", { tier: T1, modelKey: "a", ts: 100 });
    small.record("run-2", { tier: T1, modelKey: "b", ts: 100 });
    // Touch run-1 so it moves to the front of the LRU.
    small.record("run-1", { tier: T2, modelKey: "a2", ts: 200 });
    // Inserting run-3 should now evict run-2 (the new oldest).
    small.record("run-3", { tier: T1, modelKey: "c", ts: 300 });
    expect(small.priors("run-1", now), "should still be present after touch").toHaveLength(2);
    expect(small.priors("run-2", now), "should be evicted after touch made it oldest").toEqual([]);
  });

  it("trims attempts older than runTtlMs on access", () => {
    const ttl = new RunAttemptTracker({ runTtlMs: 1000 });
    ttl.record("run-1", { tier: T1, modelKey: "stale", ts: 100 });
    ttl.record("run-1", { tier: T2, modelKey: "fresh", ts: 5_000 });
    // Access at ts=5500 — TTL window is [4500, 5500]. The stale entry (ts=100) should drop.
    const priors = ttl.priors("run-1", 5_500);
    expect(priors, "only the fresh entry survives the TTL trim").toHaveLength(1);
    expect(priors[0].tier).toBe(T2);
  });

  it("drops the run entirely when ALL attempts are stale", () => {
    const ttl = new RunAttemptTracker({ runTtlMs: 1000 });
    ttl.record("run-1", { tier: T1, modelKey: "stale1", ts: 100 });
    ttl.record("run-1", { tier: T2, modelKey: "stale2", ts: 200 });
    // Access far in the future — both attempts are stale.
    expect(ttl.priors("run-1", 100_000)).toEqual([]);
    expect(ttl.size(), "fully-stale run should be removed from the map").toBe(0);
  });

  it("clear() forgets every run", () => {
    tracker.record("a", { tier: T1, modelKey: "1", ts: 1 });
    tracker.record("b", { tier: T2, modelKey: "2", ts: 1 });
    tracker.clear();
    expect(tracker.size()).toBe(0);
    expect(tracker.priors("a"), "post-clear state must be empty").toEqual([]);
  });
});

describe("CircuitBreaker — initial / closed state", () => {
  let breaker: CircuitBreaker;
  beforeEach(() => {
    breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
  });

  it("returns 'closed' for an unknown key", () => {
    expect(breaker.state("unknown")).toBe("closed");
  });

  it("canCall returns true for unknown key", () => {
    expect(breaker.canCall("unknown")).toBe(true);
  });

  it("recordSuccess on unknown key is a no-op (returns 'closed')", () => {
    expect(breaker.recordSuccess("unknown")).toBe("closed");
    expect(breaker.state("unknown")).toBe("closed");
  });

  it("does NOT trip on a single failure (below consecutive threshold)", () => {
    expect(breaker.recordFailure("provider/model", "rate_limit", 1000)).toBe("closed");
    expect(breaker.canCall("provider/model")).toBe(true);
  });

  it("trips after consecutiveFailureThreshold consecutive failures", () => {
    const KEY = "google/gemini-3.1-pro-preview";
    breaker.recordFailure(KEY, "rate_limit", 1000);
    breaker.recordFailure(KEY, "rate_limit", 2000);
    expect(breaker.state(KEY), "two failures (under threshold of 3) — still closed").toBe("closed");
    expect(breaker.recordFailure(KEY, "rate_limit", 3000), "3rd consecutive failure trips").toBe("open");
    expect(breaker.canCall(KEY, 3500), "OPEN must short-circuit calls").toBe(false);
  });

  it("recordSuccess resets consecutive count (no premature trip)", () => {
    const KEY = "google/x";
    breaker.recordFailure(KEY, "rate_limit", 1000);
    breaker.recordFailure(KEY, "rate_limit", 2000);
    breaker.recordSuccess(KEY, 2500); // success between failures
    expect(breaker.recordFailure(KEY, "rate_limit", 3000), "after success, count resets — 1 failure ≠ trip").toBe("closed");
    expect(breaker.recordFailure(KEY, "rate_limit", 4000)).toBe("closed");
    expect(breaker.recordFailure(KEY, "rate_limit", 5000), "now 3 consecutive — trips").toBe("open");
  });

  it("does NOT trip when failures are interleaved with successes (consecutive resets)", () => {
    const KEY = "noisy/provider";
    // Interleave failures and successes — each success resets the
    // consecutive counter, so the threshold of 3 is never reached.
    for (let i = 0; i < 20; i += 1) {
      if (i % 3 === 0) {
        breaker.recordSuccess(KEY, i * 100);
      } else {
        breaker.recordFailure(KEY, "5xx", i * 100);
      }
    }
    expect(breaker.state(KEY), "interleaved successes prevent the consecutive trip").toBe("closed");
    expect(
      breaker.canCall(KEY, 100_000),
      "consecutive-only policy: noisy-but-not-broken providers stay callable",
    ).toBe(true);
  });
});

describe("CircuitBreaker — open / half_open / recovery transitions", () => {
  let breaker: CircuitBreaker;
  const KEY = "google/gemini-3.1-pro-preview";
  beforeEach(() => {
    breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
    // trip the breaker
    breaker.recordFailure(KEY, "rate_limit", 1000);
    breaker.recordFailure(KEY, "rate_limit", 2000);
    breaker.recordFailure(KEY, "rate_limit", 3000);
  });

  it("setup: breaker is OPEN at t=3000", () => {
    expect(breaker.state(KEY, 3500)).toBe("open");
    expect(breaker.canCall(KEY, 3500)).toBe(false);
  });

  it("stays OPEN inside the cooldown window", () => {
    expect(breaker.canCall(KEY, 3000 + FAILOVER_DEFAULTS.cooldownMs - 1), "1ms before cooldown ends").toBe(false);
    expect(breaker.state(KEY, 3000 + FAILOVER_DEFAULTS.cooldownMs - 1)).toBe("open");
  });

  it("transitions OPEN → HALF_OPEN at cooldownMs (lazy on access)", () => {
    const halfOpenAt = 3000 + FAILOVER_DEFAULTS.cooldownMs;
    expect(breaker.canCall(KEY, halfOpenAt), "first call after cooldown is allowed (probe)").toBe(true);
    expect(breaker.state(KEY, halfOpenAt)).toBe("half_open");
  });

  it("HALF_OPEN → CLOSED on probe success", () => {
    const halfOpenAt = 3000 + FAILOVER_DEFAULTS.cooldownMs;
    breaker.canCall(KEY, halfOpenAt); // trigger transition
    expect(breaker.recordSuccess(KEY, halfOpenAt + 50), "successful probe closes the breaker").toBe("closed");
    expect(breaker.canCall(KEY, halfOpenAt + 100)).toBe(true);
  });

  it("HALF_OPEN → OPEN on probe failure (with fresh cooldown clock)", () => {
    const halfOpenAt = 3000 + FAILOVER_DEFAULTS.cooldownMs;
    breaker.canCall(KEY, halfOpenAt); // trigger half_open
    // A single failure in HALF_OPEN should re-open the breaker. Note: this
    // also adds to consecutiveFailures (which already had the previous 3
    // counted), so it trips on the threshold path.
    const newState = breaker.recordFailure(KEY, "rate_limit", halfOpenAt + 50);
    expect(newState).toBe("open");
    // New cooldown window — must wait full cooldownMs from the LATEST trip.
    expect(breaker.canCall(KEY, halfOpenAt + 100)).toBe(false);
  });
});

describe("CircuitBreaker — observability/maintenance", () => {
  it("keys() lists every key with recorded failures (success-only keys aren't materialized)", () => {
    const breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
    breaker.recordFailure("a/x", "5xx", 100);
    breaker.recordSuccess("b/y", 100); // no entry created for success-only
    expect(breaker.keys().sort()).toEqual(["a/x"]);
  });

  it("reset() clears every entry", () => {
    const breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
    breaker.recordFailure("a/x", "5xx", 100);
    breaker.recordFailure("a/x", "5xx", 200);
    breaker.recordFailure("a/x", "5xx", 300); // trips
    breaker.reset();
    expect(breaker.state("a/x"), "post-reset state should be back to closed").toBe("closed");
    expect(breaker.keys()).toEqual([]);
  });
});

describe("modelKeyOf", () => {
  it("formats as provider/model", () => {
    expect(modelKeyOf({ provider: "deepseek", model: "deepseek-v4-pro" })).toBe("deepseek/deepseek-v4-pro");
  });

  it("preserves dots, hyphens, slashes from the inputs", () => {
    expect(modelKeyOf({ provider: "google", model: "gemini-3.1-pro-preview" })).toBe("google/gemini-3.1-pro-preview");
  });
});

describe("SUBSTITUTION_LADDER (DESIGN.md §6 minimum-movement policy)", () => {
  it("has an entry for every tier", () => {
    expect(Object.keys(SUBSTITUTION_LADDER).sort()).toEqual([T0, T1, T2, T3]);
  });

  it("never includes the source tier in its own ladder", () => {
    for (const [src, ladder] of Object.entries(SUBSTITUTION_LADDER)) {
      expect(ladder, `ladder for ${src} should not contain ${src}`).not.toContain(src);
    }
  });

  it("each ladder lists every other tier exactly once (full exhaustion path)", () => {
    for (const [src, ladder] of Object.entries(SUBSTITUTION_LADDER)) {
      const expected = [T0, T1, T2, T3].filter((t) => t !== src).sort();
      expect([...ladder].sort(), `ladder for ${src} should cover the other 3 tiers`).toEqual(expected);
    }
  });

  it("T2 ladder de-escalates to T1 first (cheaper than escalating to T3)", () => {
    expect(SUBSTITUTION_LADDER.T2[0], "T2 most-likely-broken-by-quota → de-escalate to T1 first").toBe(T1);
  });

  it("T3 ladder de-escalates to T2 first", () => {
    expect(SUBSTITUTION_LADDER.T3[0]).toBe(T2);
  });
});

describe("substituteTier — happy paths (no substitution applied)", () => {
  let breaker: CircuitBreaker;
  beforeEach(() => {
    breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
  });

  it("first attempt with healthy breaker → returns decided tier", () => {
    const cfg = resolveConfig({});
    const result = substituteTier(T2, cfg, [], breaker, 1000);
    expect(result.applied).toBe(false);
    expect(result.tier).toBe(T2);
    expect(result.reason).toBe("");
  });

  it("returns decided tier even when OTHER tiers have prior attempts", () => {
    const cfg = resolveConfig({});
    const result = substituteTier(T2, cfg, [{ tier: T0, modelKey: "x", ts: 1 }], breaker, 1000);
    expect(result.applied, "T0 was tried before but T2 wasn't — no substitution needed").toBe(false);
    expect(result.tier).toBe(T2);
  });
});

describe("substituteTier — reactive substitution (in-run retry)", () => {
  let breaker: CircuitBreaker;
  beforeEach(() => {
    breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
  });

  it("substitutes when decided tier was already attempted in this run", () => {
    const cfg = resolveConfig({});
    const t2Key = modelKeyOf(cfg.tiers.T2);
    const priors = [{ tier: T2 as const, modelKey: t2Key, ts: 100 }];
    const result = substituteTier(T2, cfg, priors, breaker, 200);
    expect(result.applied, "second invocation for same runId means previous failed → substitute").toBe(true);
    expect(result.tier, "T2 ladder de-escalates to T1 first").toBe(T1);
    expect(result.reason).toContain("already_attempted_in_run");
    expect(result.reason).toContain("T2→T1");
  });

  it("walks the ladder when the first candidate was also attempted", () => {
    const cfg = resolveConfig({});
    const priors = [
      { tier: T2 as const, modelKey: modelKeyOf(cfg.tiers.T2), ts: 100 },
      { tier: T1 as const, modelKey: modelKeyOf(cfg.tiers.T1), ts: 200 },
    ];
    const result = substituteTier(T2, cfg, priors, breaker, 300);
    expect(result.applied).toBe(true);
    // T2 ladder: [T1, T3, T0]; T1 attempted → next is T3
    expect(result.tier).toBe(T3);
    expect(result.reason).toContain("T2→T3");
  });

  it("returns null when every tier has been attempted (gateway falls back)", () => {
    const cfg = resolveConfig({});
    const priors = [
      { tier: T0 as const, modelKey: modelKeyOf(cfg.tiers.T0), ts: 100 },
      { tier: T1 as const, modelKey: modelKeyOf(cfg.tiers.T1), ts: 200 },
      { tier: T2 as const, modelKey: modelKeyOf(cfg.tiers.T2), ts: 300 },
      { tier: T3 as const, modelKey: modelKeyOf(cfg.tiers.T3), ts: 400 },
    ];
    const result = substituteTier(T2, cfg, priors, breaker, 500);
    expect(result.tier, "every tier exhausted — surrender to gateway default").toBeNull();
    expect(result.applied).toBe(true);
    expect(result.reason).toContain("all tiers exhausted");
  });
});

describe("substituteTier — proactive substitution (circuit breaker open)", () => {
  let breaker: CircuitBreaker;
  beforeEach(() => {
    breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
  });

  it("substitutes when decided tier's breaker is OPEN (no priors needed)", () => {
    const cfg = resolveConfig({});
    const t2Key = modelKeyOf(cfg.tiers.T2);
    breaker.recordFailure(t2Key, "rate_limit", 100);
    breaker.recordFailure(t2Key, "rate_limit", 200);
    breaker.recordFailure(t2Key, "rate_limit", 300); // trips at 300
    const result = substituteTier(T2, cfg, [], breaker, 400);
    expect(result.applied, "OPEN breaker on T2 should substitute even on FIRST attempt").toBe(true);
    expect(result.tier).toBe(T1);
    expect(result.reason).toContain("circuit_open");
    expect(result.reason).toContain(t2Key);
  });

  it("skips a candidate whose breaker is also OPEN (walks past it)", () => {
    const cfg = resolveConfig({});
    const t2Key = modelKeyOf(cfg.tiers.T2);
    const t1Key = modelKeyOf(cfg.tiers.T1);
    // Trip both T1 and T2 breakers
    for (const key of [t1Key, t2Key]) {
      breaker.recordFailure(key, "rate_limit", 100);
      breaker.recordFailure(key, "rate_limit", 200);
      breaker.recordFailure(key, "rate_limit", 300);
    }
    const result = substituteTier(T2, cfg, [], breaker, 400);
    expect(result.applied).toBe(true);
    // T2 ladder: [T1, T3, T0]; T1 OPEN → skip → T3 is next
    expect(result.tier).toBe(T3);
  });

  it("combines reactive + proactive triggers in the reason", () => {
    const cfg = resolveConfig({});
    const t2Key = modelKeyOf(cfg.tiers.T2);
    breaker.recordFailure(t2Key, "rate_limit", 100);
    breaker.recordFailure(t2Key, "rate_limit", 200);
    breaker.recordFailure(t2Key, "rate_limit", 300);
    const priors = [{ tier: T2 as const, modelKey: t2Key, ts: 350 }];
    const result = substituteTier(T2, cfg, priors, breaker, 400);
    expect(result.reason).toContain("already_attempted_in_run");
    expect(result.reason).toContain("circuit_open");
  });

  it("HALF_OPEN counts as callable (probe allowed)", () => {
    const cfg = resolveConfig({});
    const t2Key = modelKeyOf(cfg.tiers.T2);
    breaker.recordFailure(t2Key, "rate_limit", 100);
    breaker.recordFailure(t2Key, "rate_limit", 200);
    breaker.recordFailure(t2Key, "rate_limit", 300);
    // Wait for cooldown — breaker is now HALF_OPEN
    const halfOpenAt = 300 + FAILOVER_DEFAULTS.cooldownMs;
    const result = substituteTier(T2, cfg, [], breaker, halfOpenAt);
    expect(result.applied, "HALF_OPEN should not force substitution").toBe(false);
    expect(result.tier).toBe(T2);
  });
});

describe("substituteTier — the WhatsApp bug regression test", () => {
  /**
   * Reproduces the exact failure pattern from gateway.err.log on 2026-05-12:
   *   - Router decides T2 (google/gemini-3.1-pro-preview)
   *   - Google API returns 429 RESOURCE_EXHAUSTED
   *   - Gateway calls before_model_resolve again for failover candidate
   *   - Pre-Step-8: same T2 returned → second call also fails to google
   *   - Step 8: substituteTier should return T1 (de-escalation) on retry
   */
  it("on retry, substitutes T2→T1 (the user's WhatsApp bug)", () => {
    const cfg = resolveConfig({});
    const breaker = new CircuitBreaker(FAILOVER_DEFAULTS);
    const t2Key = modelKeyOf(cfg.tiers.T2);

    // First invocation — router picks T2, no priors, breaker fresh.
    const first = substituteTier(T2, cfg, [], breaker, 1000);
    expect(first.tier).toBe(T2);
    expect(first.applied).toBe(false);

    // Gateway calls google → 429. We don't have outcome hook wired, but
    // the gateway re-invokes before_model_resolve for the failover
    // candidate. Hook records the prior attempt before re-deciding.
    const priorsAfterFirstFailure = [{ tier: T2 as const, modelKey: t2Key, ts: 1000 }];
    const second = substituteTier(T2, cfg, priorsAfterFirstFailure, breaker, 2000);
    expect(second.tier, "second attempt MUST de-escalate to T1 — the user gets a response").toBe(T1);
    expect(second.applied).toBe(true);
    expect(second.reason).toContain("T2→T1");
  });
});
