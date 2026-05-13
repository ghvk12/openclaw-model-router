import { describe, it, expect } from "vitest";
import {
  computeAudit,
  formatAudit,
  harvestExemplars,
  formatHarvest,
  type AuditSummary,
  type HarvestedExemplar,
} from "../src/cli.js";

/**
 * CLI unit tests (DESIGN.md §15 step 9). Tests exercise the pure
 * WAL-parsing and summary functions; no filesystem I/O required since
 * loadRows is integration-tested separately via the live smoke run.
 */

type ParsedRow = Parameters<typeof computeAudit>[0][0];

function makeRow(overrides: Partial<ParsedRow> = {}): ParsedRow {
  return {
    ts: Date.now(),
    runId: "run-1",
    promptHash: "sha256:abc",
    promptLen: 100,
    tokenCountEstimate: 25,
    tierChosen: "T1",
    providerChosen: "deepseek",
    modelChosen: "deepseek-v4-pro",
    confidence: 0.8,
    classifiers: ["heuristic_escalate"],
    reason: "heuristic escalate: pattern",
    classifierLatencyMs: 1.5,
    priorTier: null,
    failoverApplied: false,
    routedLive: true,
    ...overrides,
  };
}

describe("computeAudit — basic tier distribution", () => {
  it("counts empty rows as zero for every tier", () => {
    const summary = computeAudit([]);
    expect(summary.totalDecisions).toBe(0);
    expect(summary.dateRange).toBeNull();
    for (const t of ["T0", "T1", "T2", "T3"] as const) {
      expect(summary.tierDistribution[t].count).toBe(0);
      expect(summary.tierDistribution[t].pct).toBe("0.0%");
    }
    expect(summary.avgConfidence).toBe(0);
  });

  it("produces correct tier counts for mixed input", () => {
    const rows = [
      makeRow({ tierChosen: "T0" }),
      makeRow({ tierChosen: "T1" }),
      makeRow({ tierChosen: "T1" }),
      makeRow({ tierChosen: "T2" }),
      makeRow({ tierChosen: "T3" }),
    ];
    const s = computeAudit(rows);
    expect(s.totalDecisions).toBe(5);
    expect(s.tierDistribution.T0.count).toBe(1);
    expect(s.tierDistribution.T1.count).toBe(2);
    expect(s.tierDistribution.T2.count).toBe(1);
    expect(s.tierDistribution.T3.count).toBe(1);
    expect(s.tierDistribution.T0.pct).toBe("20.0%");
    expect(s.tierDistribution.T1.pct).toBe("40.0%");
  });
});

describe("computeAudit — failover tracking", () => {
  it("counts failoverApplied=true rows and extracts paths", () => {
    const rows = [
      makeRow({ failoverApplied: false }),
      makeRow({
        failoverApplied: true,
        originalTier: "T2",
        tierChosen: "T1",
      }),
      makeRow({
        failoverApplied: true,
        originalTier: "T2",
        tierChosen: "T1",
      }),
      makeRow({
        failoverApplied: true,
        originalTier: "T3",
        tierChosen: "T2",
      }),
    ];
    const s = computeAudit(rows);
    expect(s.failoverRate.count).toBe(3);
    expect(s.failoverRate.pct).toBe("75.0%");
    expect(s.topFailoverPaths).toHaveLength(2);
    expect(s.topFailoverPaths[0]).toEqual({
      from: "T2",
      to: "T1",
      count: 2,
    });
    expect(s.topFailoverPaths[1]).toEqual({
      from: "T3",
      to: "T2",
      count: 1,
    });
  });

  it("handles failoverApplied=true with missing originalTier gracefully", () => {
    const rows = [
      makeRow({ failoverApplied: true, tierChosen: "T1" }),
    ];
    const s = computeAudit(rows);
    expect(s.topFailoverPaths[0].from).toBe("?");
  });
});

describe("computeAudit — live-routed rate", () => {
  it("counts routedLive=true rows", () => {
    const rows = [
      makeRow({ routedLive: true }),
      makeRow({ routedLive: true }),
      makeRow({ routedLive: false }),
      makeRow({}), // routedLive undefined treated as falsy
    ];
    // delete routedLive from 4th row to simulate pre-Step7 rows
    delete (rows[3] as Record<string, unknown>).routedLive;
    const s = computeAudit(rows);
    expect(s.liveRoutedRate.count).toBe(2);
    expect(s.liveRoutedRate.pct).toBe("50.0%");
  });
});

describe("computeAudit — classifier breakdown", () => {
  it("counts every classifier label across all rows", () => {
    const rows = [
      makeRow({ classifiers: ["heuristic_escalate"] }),
      makeRow({ classifiers: ["semantic", "semantic_T1"] }),
      makeRow({ classifiers: ["heuristic_escalate"] }),
      makeRow({ classifiers: ["no_semantic"] }),
    ];
    const s = computeAudit(rows);
    expect(s.classifierBreakdown["heuristic_escalate"]).toBe(2);
    expect(s.classifierBreakdown["semantic"]).toBe(1);
    expect(s.classifierBreakdown["semantic_T1"]).toBe(1);
    expect(s.classifierBreakdown["no_semantic"]).toBe(1);
  });
});

describe("computeAudit — latency stats", () => {
  it("computes p50, p95, p99, mean from latencies", () => {
    const latencies = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const rows = latencies.map((l) =>
      makeRow({ classifierLatencyMs: l }),
    );
    const s = computeAudit(rows);
    expect(s.latencyStats.p50Ms).toBe(5);
    expect(s.latencyStats.meanMs).toBe(5.5);
    expect(s.latencyStats.p95Ms).toBe(10);
  });

  it("returns 0 for empty input", () => {
    const s = computeAudit([]);
    expect(s.latencyStats.p50Ms).toBe(0);
    expect(s.latencyStats.meanMs).toBe(0);
  });
});

describe("computeAudit — date range", () => {
  it("extracts earliest and latest from sorted rows", () => {
    const rows = [
      makeRow({ ts: new Date("2026-04-30T12:00:00Z").getTime() }),
      makeRow({ ts: new Date("2026-05-13T12:00:00Z").getTime() }),
    ];
    const s = computeAudit(rows);
    expect(s.dateRange).not.toBeNull();
    expect(s.dateRange!.earliest).toBe("2026-04-30");
    expect(s.dateRange!.latest).toBe("2026-05-13");
  });
});

describe("formatAudit — output formatting", () => {
  it("produces a non-empty string with key sections", () => {
    const rows = [
      makeRow({ tierChosen: "T1", classifierLatencyMs: 5 }),
      makeRow({
        tierChosen: "T2",
        failoverApplied: true,
        originalTier: "T2",
        classifierLatencyMs: 12,
      }),
    ];
    const s = computeAudit(rows);
    const output = formatAudit(s);
    expect(output).toContain("Audit Summary");
    expect(output).toContain("Tier distribution:");
    expect(output).toContain("T1: 1");
    expect(output).toContain("T2: 1");
    expect(output).toContain("Failover rate:");
    expect(output).toContain("Classifier breakdown:");
    expect(output).toContain("Classifier latency:");
    expect(output).toContain("p50=");
  });
});

describe("harvestExemplars — basic filtering", () => {
  it("returns rows above the min confidence threshold", () => {
    const rows = [
      makeRow({ confidence: 0.90, promptHash: "sha256:a" }),
      makeRow({ confidence: 0.50, promptHash: "sha256:b" }),
      makeRow({ confidence: 0.75, promptHash: "sha256:c" }),
    ];
    const result = harvestExemplars(rows, 0.70);
    expect(result).toHaveLength(2);
    expect(result[0].confidence).toBeGreaterThanOrEqual(0.70);
    expect(result[1].confidence).toBeGreaterThanOrEqual(0.70);
  });

  it("excludes failover rows (they're unreliable as exemplars)", () => {
    const rows = [
      makeRow({
        confidence: 0.95,
        promptHash: "sha256:failover",
        failoverApplied: true,
      }),
    ];
    const result = harvestExemplars(rows, 0.70);
    expect(result).toHaveLength(0);
  });

  it("excludes no_semantic default-T1 rows (low signal)", () => {
    const rows = [
      makeRow({
        confidence: 0.90,
        promptHash: "sha256:nosem",
        classifiers: ["no_semantic"],
      }),
    ];
    const result = harvestExemplars(rows, 0.70);
    expect(result).toHaveLength(0);
  });

  it("deduplicates by promptHash (keeps highest confidence)", () => {
    const rows = [
      makeRow({
        confidence: 0.80,
        promptHash: "sha256:dup",
        tierChosen: "T1",
      }),
      makeRow({
        confidence: 0.92,
        promptHash: "sha256:dup",
        tierChosen: "T2",
      }),
      makeRow({
        confidence: 0.85,
        promptHash: "sha256:dup",
        tierChosen: "T1",
      }),
    ];
    const result = harvestExemplars(rows, 0.70);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.92);
    expect(result[0].tier).toBe("T2");
  });

  it("sorts output by confidence descending", () => {
    const rows = [
      makeRow({ confidence: 0.75, promptHash: "sha256:low" }),
      makeRow({ confidence: 0.95, promptHash: "sha256:high" }),
      makeRow({ confidence: 0.85, promptHash: "sha256:mid" }),
    ];
    const result = harvestExemplars(rows, 0.70);
    expect(result.map((e) => e.confidence)).toEqual([0.95, 0.85, 0.75]);
  });

  it("returns empty array when no rows pass filters", () => {
    const result = harvestExemplars([], 0.70);
    expect(result).toEqual([]);
  });
});

describe("formatHarvest — output formats", () => {
  const exemplars: HarvestedExemplar[] = [
    {
      promptHash: "sha256:abc",
      tier: "T1",
      confidence: 0.92,
      classifiers: ["semantic", "semantic_T1"],
      reason: "semantic T1 @ 0.92",
      promptLen: 150,
    },
    {
      promptHash: "sha256:def",
      tier: "T2",
      confidence: 0.85,
      classifiers: ["heuristic_escalate"],
      reason: "heuristic escalate: refactor",
      promptLen: 300,
    },
  ];

  it("formats as TSV with header row", () => {
    const tsv = formatHarvest(exemplars, "tsv");
    const lines = tsv.split("\n");
    expect(lines[0]).toContain("promptHash\ttier\tconfidence");
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain("sha256:abc");
    expect(lines[1]).toContain("T1");
    expect(lines[1]).toContain("0.920");
  });

  it("formats as JSON array", () => {
    const json = formatHarvest(exemplars, "json");
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].promptHash).toBe("sha256:abc");
    expect(parsed[1].tier).toBe("T2");
  });
});
