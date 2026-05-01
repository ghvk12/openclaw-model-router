import { describe, it, expect } from "vitest";
import {
  SEED_EXEMPLARS,
  SEED_EXEMPLARS_VERSION,
  exemplarId,
  type Exemplar,
} from "../src/classifier/exemplars.js";

/**
 * Pure-data tests for the seed exemplar list. Catches accidental
 * malformations (duplicate ids, empty texts, T3 leakage, missing
 * tiers) at build time so a bad commit can't quietly degrade routing
 * accuracy in production.
 */

describe("SEED_EXEMPLARS — shape contract", () => {
  it("contains at least 50 exemplars (DESIGN.md §5 minimum)", () => {
    expect(
      SEED_EXEMPLARS.length,
      "DESIGN.md §5 requires 50–100 hand-curated exemplars",
    ).toBeGreaterThanOrEqual(50);
  });

  it("only labels exemplars T0/T1/T2 — never T3", () => {
    // T3 (Gemini) is reached only via hard escalation rules
    // (long-context, multimodal, failover) per DESIGN.md §5.
    // A T3 exemplar would teach the semantic classifier to vote T3,
    // which is the wrong cost lever — escalations should be deterministic.
    for (const ex of SEED_EXEMPLARS) {
      expect(
        ex.tier,
        `exemplar "${ex.text}" must not be T3`,
      ).not.toBe("T3");
      expect(
        ["T0", "T1", "T2"].includes(ex.tier),
        `exemplar "${ex.text}" must be T0|T1|T2 (got ${ex.tier})`,
      ).toBe(true);
    }
  });

  it("has at least 15 exemplars per tier (T0/T1/T2)", () => {
    const counts = new Map<string, number>();
    for (const ex of SEED_EXEMPLARS) {
      counts.set(ex.tier, (counts.get(ex.tier) ?? 0) + 1);
    }
    for (const tier of ["T0", "T1", "T2"]) {
      expect(
        counts.get(tier) ?? 0,
        `tier ${tier} must have ≥15 exemplars (avoids unbalanced vote weighting)`,
      ).toBeGreaterThanOrEqual(15);
    }
  });

  it("has unique ids (deterministic-id contract)", () => {
    const ids = new Set<string>();
    for (const ex of SEED_EXEMPLARS) {
      expect(
        ids.has(ex.id),
        `duplicate exemplar id ${ex.id} (text="${ex.text}", tier=${ex.tier})`,
      ).toBe(false);
      ids.add(ex.id);
    }
  });

  it("has unique (tier, text) pairs", () => {
    const seen = new Set<string>();
    for (const ex of SEED_EXEMPLARS) {
      const key = `${ex.tier}\n${ex.text}`;
      expect(
        seen.has(key),
        `duplicate (tier, text) pair: tier=${ex.tier}, text="${ex.text}"`,
      ).toBe(false);
      seen.add(key);
    }
  });

  it("has non-empty trimmed texts", () => {
    for (const ex of SEED_EXEMPLARS) {
      expect(ex.text.trim().length, "exemplar text must be non-empty").toBeGreaterThan(0);
      expect(
        ex.text,
        "exemplar text must equal its trimmed form (no leading/trailing whitespace)",
      ).toBe(ex.text.trim());
    }
  });

  it("marks every seed entry with source='seed'", () => {
    for (const ex of SEED_EXEMPLARS) {
      expect(ex.source).toBe("seed");
    }
  });

  it("frozen list is read-only at runtime", () => {
    expect(Object.isFrozen(SEED_EXEMPLARS), "SEED_EXEMPLARS must be Object.frozen").toBe(true);
  });
});

describe("exemplarId — deterministic and unique", () => {
  it("produces the same id for the same (text, tier) input", () => {
    const a = exemplarId("hello world", "T0");
    const b = exemplarId("hello world", "T0");
    expect(a).toBe(b);
  });

  it("produces different ids for different tiers (same text)", () => {
    const t0 = exemplarId("ambiguous", "T0");
    const t2 = exemplarId("ambiguous", "T2");
    expect(t0, "tier should be part of the id mix").not.toBe(t2);
  });

  it("produces different ids for different texts (same tier)", () => {
    const a = exemplarId("foo", "T1");
    const b = exemplarId("bar", "T1");
    expect(a).not.toBe(b);
  });

  it("emits UUIDv5-style 8-4-4-4-12 hex strings", () => {
    const id = exemplarId("test prompt", "T1");
    expect(id, "id should be UUIDv5-style hex").toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  });
});

describe("SEED_EXEMPLARS_VERSION", () => {
  it("is a positive integer", () => {
    expect(typeof SEED_EXEMPLARS_VERSION).toBe("number");
    expect(SEED_EXEMPLARS_VERSION).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(SEED_EXEMPLARS_VERSION), "version must be an integer").toBe(true);
  });
});
