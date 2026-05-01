import { describe, it, expect, vi } from "vitest";
import { decide, type DecisionDeps, type DecisionInput } from "../src/classifier/decision.js";
import { resolveConfig } from "../src/config.js";
import type { SemanticDeps } from "../src/classifier/semantic.js";
import type { ExemplarHit, RouterQdrantClient } from "../src/classifier/qdrant-router.js";
import type { RouterEmbedder } from "../src/classifier/embedder.js";
import type { TierId } from "../src/config.js";

/**
 * Decision orchestrator tests. The decider is the heart of the router —
 * every other module exists to feed it inputs. These tests cover every
 * branch of DESIGN.md §5 by constructing input prompts and mocked
 * semantic deps that force each precedence rule to fire.
 */

const cfg = resolveConfig({}).classifier;

function makeMockSemantic(hits: ExemplarHit[], vec = [0.1, 0.2]): SemanticDeps {
  return {
    embedder: {
      embedQuery: vi.fn().mockResolvedValue(vec),
      embedBatch: vi.fn().mockResolvedValue([vec]),
      probe: vi.fn().mockResolvedValue({ ok: true }),
      model: "mxbai-embed-large",
      dim: vec.length,
      url: "http://localhost:11434",
    } as unknown as RouterEmbedder,
    qdrant: {
      ensureCollection: vi.fn().mockResolvedValue(undefined),
      search: vi.fn().mockResolvedValue(hits),
      upsertExemplars: vi.fn().mockResolvedValue(undefined),
      countPoints: vi.fn().mockResolvedValue(60),
    } as unknown as RouterQdrantClient,
  };
}

function hit(tier: TierId, score: number, text = `${tier} exemplar`): ExemplarHit {
  return {
    id: `mock-${tier}-${score}`,
    score,
    payload: { text, tier, source: "seed", version: 1 },
  };
}

function input(prompt: string, opts: Partial<DecisionInput> = {}): DecisionInput {
  return {
    prompt,
    priorTier: opts.priorTier ?? null,
    ...(opts.attachments !== undefined ? { attachments: opts.attachments } : {}),
  };
}

// ── 1. HARD ESCALATIONS ────────────────────────────────────────────────

describe("decide — hard escalation: long context → T3", () => {
  it("forces T3 when token estimate exceeds longContextThreshold", async () => {
    const deps: DecisionDeps = { semantic: null };
    // 1M ASCII chars ≈ 250K tokens, well above default 200K threshold.
    const r = await decide(input("x".repeat(1_000_000)), cfg, deps);
    expect(r.decision.tier).toBe("T3");
    expect(r.decision.classifiers).toEqual(["long_context_override"]);
    expect(r.decision.confidence, "long context is deterministic").toBe(1.0);
    expect(r.decision.reason, "reason should mention the threshold").toContain("longContextThreshold");
  });

  it("does NOT escalate when token estimate is below the threshold", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(input("Tell me something interesting about the weather today."), cfg, deps);
    expect(r.decision.tier, "should not auto-T3 a normal prompt").not.toBe("T3");
  });

  it("hard-escalation runs BEFORE the heuristic — even an escalate prompt with too many tokens lands T3", async () => {
    const deps: DecisionDeps = { semantic: null };
    const longCode = "refactor this:\n```\n" + "x".repeat(1_000_000) + "\n```";
    const r = await decide(input(longCode), cfg, deps);
    expect(r.decision.tier, "long context wins over heuristic.escalate").toBe("T3");
    expect(r.decision.classifiers).toEqual(["long_context_override"]);
  });
});

describe("decide — hard escalation: multimodal → T3", () => {
  it("forces T3 on image attachment", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(
      input("describe this", { attachments: [{ kind: "image", mimeType: "image/png" }] }),
      cfg,
      deps,
    );
    expect(r.decision.tier).toBe("T3");
    expect(r.decision.classifiers).toEqual(["multimodal_override"]);
    expect(r.decision.reason).toContain("image");
  });

  it("forces T3 on video and audio attachments", async () => {
    const deps: DecisionDeps = { semantic: null };
    for (const kind of ["video", "audio"] as const) {
      const r = await decide(
        input("look at this", { attachments: [{ kind }] }),
        cfg,
        deps,
      );
      expect(r.decision.tier, `${kind} should escalate to T3`).toBe("T3");
      expect(r.decision.classifiers).toEqual(["multimodal_override"]);
    }
  });

  it("does NOT escalate on document attachment (DESIGN.md §5: docs fit DeepSeek context)", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(
      input("summarize this document", { attachments: [{ kind: "document" }] }),
      cfg,
      deps,
    );
    expect(r.decision.tier, "documents should NOT auto-T3").not.toBe("T3");
  });
});

// ── 2. HEURISTIC FAST PATH ─────────────────────────────────────────────

describe("decide — heuristic escalate → T2", () => {
  it("returns T2 when heuristic flags escalate (e.g. 'refactor')", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(
      input(
        "Please refactor the payment service to handle retries correctly when downstream APIs return 5xx errors.",
      ),
      cfg,
      deps,
    );
    expect(r.decision.tier).toBe("T2");
    expect(r.decision.classifiers).toContain("heuristic_escalate");
    expect(r.decision.confidence).toBe(0.85);
    expect(r.decision.reason).toContain("escalate");
  });

  it("returns T2 on code-fence prompts even without escalate keywords", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(input("here's some code:\n```\nfoo();\n```\n"), cfg, deps);
    expect(r.decision.tier).toBe("T2");
    expect(r.decision.classifiers).toContain("heuristic_escalate");
  });
});

// ── 3. SEMANTIC DISABLED OR UNAVAILABLE ────────────────────────────────

describe("decide — no semantic available → conservative T1", () => {
  it("returns T1 with no_semantic + heuristic_trivial labels for trivial prompts", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(input("ok thanks"), cfg, deps);
    expect(r.decision.tier, "trivial without semantic confirmation must NOT be downgraded to T0").toBe(
      "T1",
    );
    expect(r.decision.classifiers).toEqual(["heuristic_trivial", "no_semantic"]);
    expect(r.decision.confidence).toBe(0.6);
  });

  it("returns T1 with only no_semantic label for neutral prompts", async () => {
    const deps: DecisionDeps = { semantic: null };
    // Must be > maxTrivialChars (80) so the heuristic doesn't fire
    // trivial_short_no_question, otherwise we'd be testing the
    // heuristic_trivial+no_semantic branch instead of the neutral one.
    const r = await decide(
      input(
        "Tell me about today's calendar with appointments, reminders, and any deadlines I should know about for the rest of this week.",
      ),
      cfg,
      deps,
    );
    expect(r.decision.tier).toBe("T1");
    expect(r.decision.classifiers).toEqual(["no_semantic"]);
    expect(r.decision.confidence).toBe(0.5);
  });

  it("treats semantic-disabled-in-config the same as semantic-deps-null", async () => {
    const cfgDisabled = resolveConfig({
      classifier: { semantic: { enabled: false } },
    }).classifier;
    const fakeDeps: DecisionDeps = { semantic: makeMockSemantic([hit("T0", 0.99)]) };
    const r = await decide(input("ok thanks"), cfgDisabled, fakeDeps);
    expect(r.decision.classifiers).toContain("no_semantic");
    expect(r.decision.tier, "even with mocked semantic deps, disabled config skips it").toBe("T1");
    expect(fakeDeps.semantic?.embedder.embedQuery, "embedQuery should not be called").not.toHaveBeenCalled();
  });
});

// ── 4. SEMANTIC PATH — FAIL-SOFT ───────────────────────────────────────

describe("decide — semantic_failed → T1 fallback", () => {
  it("returns T1 with semantic_failed label when runSemantic throws", async () => {
    const deps: DecisionDeps = {
      semantic: {
        embedder: {
          embedQuery: vi.fn().mockRejectedValue(new Error("Ollama timeout")),
          embedBatch: vi.fn(),
          probe: vi.fn(),
          model: "x",
          dim: 1,
          url: "http://localhost",
        } as unknown as RouterEmbedder,
        qdrant: {} as unknown as RouterQdrantClient,
      },
    };
    const r = await decide(input("a normal-ish prompt about something neutral"), cfg, deps);
    expect(r.decision.tier).toBe("T1");
    expect(r.decision.classifiers).toEqual(["semantic_failed"]);
    expect(r.decision.confidence).toBe(0.45);
    expect(r.decision.reason).toContain("Ollama timeout");
  });
});

// ── 5. COMBINE SIGNALS ─────────────────────────────────────────────────

describe("decide — both signals agree on trivial → T0", () => {
  it("returns T0 when heuristic.trivial AND semantic T0 with confidence > 0.80", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T0", 0.99, "thanks"), hit("T0", 0.95, "ok"), hit("T2", 0.1)]),
    };
    // "ok" trips trivial_pattern_match AND trivial_short_no_question
    const r = await decide(input("ok"), cfg, deps);
    expect(r.decision.tier).toBe("T0");
    expect(r.decision.classifiers).toEqual(["heuristic_trivial", "semantic_T0"]);
    expect(r.decision.confidence, "should reflect semantic confidence").toBeGreaterThan(0.8);
    expect(r.decision.confidence, "but capped at 0.95").toBeLessThanOrEqual(0.95);
  });

  it("does NOT downgrade to T0 when semantic confidence is too low", async () => {
    // Both T0 hits but tied → confidence=0
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T0", 0.5), hit("T1", 0.5)]),
    };
    const r = await decide(input("ok"), cfg, deps);
    expect(r.decision.tier, "low semantic confidence keeps us off T0").not.toBe("T0");
  });

  it("does NOT downgrade to T0 when heuristic doesn't agree (only semantic flags T0)", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T0", 0.99), hit("T2", 0.1)]),
    };
    // Long neutral prompt avoids both heuristic.trivial AND escalate.
    const r = await decide(
      input("Please provide a brief overview of the architectural decisions we've already discussed."),
      cfg,
      deps,
    );
    expect(r.decision.tier, "semantic alone can't downgrade to T0").toBe("T1");
    expect(r.decision.classifiers).toEqual(["semantic_T0", "heuristic_disagreed"]);
  });
});

describe("decide — sticky prior bias", () => {
  it("keeps prior tier when semantic confidence < marginThreshold", async () => {
    // priorTier=T0 doesn't appear in the hits → no sticky boost in
    // aggregateVotes → tied T1/T2 yields confidence=0 → below default
    // marginThreshold (0.05) → sticky_prior path in decision.ts fires.
    // Long neutral prompt (>80 chars, no escalate kw, no '?') skips
    // the trivial and escalate fast paths.
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T1", 0.5), hit("T2", 0.5)]),
    };
    const r = await decide(
      input(
        "Some neutral prompt that is intentionally long enough to skip the trivial heuristic short_no_question rule.",
        { priorTier: "T0" },
      ),
      cfg,
      deps,
    );
    expect(r.decision.tier, "should keep priorTier T0").toBe("T0");
    expect(r.decision.classifiers).toEqual(["sticky_prior"]);
    expect(r.decision.confidence).toBe(0.55);
    expect(r.decision.reason).toContain("low semantic margin");
  });

  it("does NOT apply sticky bias when priorTier is null (cold conversation)", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T1", 0.5), hit("T2", 0.5)]),
    };
    const r = await decide(
      input(
        "Some neutral prompt that is intentionally long enough to skip the trivial heuristic short_no_question rule.",
      ),
      cfg,
      deps,
    );
    expect(
      r.decision.classifiers,
      "no priorTier → no sticky_prior label",
    ).not.toContain("sticky_prior");
  });
});

describe("decide — semantic decision honored", () => {
  it("returns T2 when semantic confidently votes T2 (and heuristic isn't escalate)", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T2", 0.95), hit("T1", 0.2), hit("T0", 0.1)]),
    };
    // Long-ish neutral prompt to skip both heuristic.escalate and trivial paths
    const r = await decide(
      input("Walk me through the considerations for this decision when you have time."),
      cfg,
      deps,
    );
    expect(r.decision.tier).toBe("T2");
    expect(r.decision.classifiers).toEqual(["semantic", "semantic_T2"]);
    expect(r.decision.reason).toContain("topExemplars");
  });

  it("returns T1 when semantic votes T1 with a clear margin", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T1", 0.9), hit("T0", 0.2)]),
    };
    const r = await decide(
      input("Compose a brief response when you have a moment, no rush at all please."),
      cfg,
      deps,
    );
    expect(r.decision.tier).toBe("T1");
    expect(r.decision.classifiers).toEqual(["semantic", "semantic_T1"]);
  });
});

// ── 6. DECISION TRACE ──────────────────────────────────────────────────

describe("decide — DecisionTrace", () => {
  it("populates totalLatencyMs as a non-negative number", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(input("ok"), cfg, deps);
    expect(typeof r.trace.totalLatencyMs).toBe("number");
    expect(r.trace.totalLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("includes the heuristic signal in the trace", async () => {
    const deps: DecisionDeps = { semantic: null };
    const r = await decide(input("ok thanks"), cfg, deps);
    expect(r.trace.heuristic.trivial, "trace should show heuristic.trivial=true").toBe(true);
    expect(r.trace.heuristic.reasons.length).toBeGreaterThan(0);
  });

  it("includes the semantic signal in the trace when semantic ran", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T1", 0.9)]),
    };
    const r = await decide(
      input("Compose a brief response when you have a moment, no rush at all."),
      cfg,
      deps,
    );
    expect(r.trace.semantic, "trace.semantic should be populated").toBeDefined();
    expect(r.trace.semantic?.tier).toBe("T1");
  });

  it("omits the semantic field in the trace for hard-escalation paths", async () => {
    const deps: DecisionDeps = {
      semantic: makeMockSemantic([hit("T0", 0.99)]),
    };
    const r = await decide(
      input("describe this", { attachments: [{ kind: "image" }] }),
      cfg,
      deps,
    );
    expect(r.trace.semantic, "hard-escalation should skip the semantic call").toBeUndefined();
    expect(deps.semantic?.embedder.embedQuery, "semantic deps should not be called").not.toHaveBeenCalled();
  });
});
