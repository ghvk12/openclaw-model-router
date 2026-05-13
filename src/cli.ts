#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expandHome } from "./paths.js";
import type { TierId } from "./config.js";

/**
 * Step 9 — `openclaw modelrouter audit` CLI (DESIGN.md §15 step 9).
 *
 * Mirrors the memrag CLI shape: standalone `node dist/cli.js <cmd>`.
 * Reads the daily-rotated JSONL WAL files, produces distribution
 * summaries, and (via `harvest`) mines high-confidence rows as new
 * exemplar candidates for operator approval.
 *
 * Sub-commands:
 *   audit   [--since=Nd] [--wal-dir=PATH]   Tier distribution, failover
 *           rate, classifier breakdown, latency stats.
 *   harvest [--since=Nd] [--wal-dir=PATH] [--min-confidence=N]
 *           [--format=json|tsv]  Propose new exemplars from
 *           high-confidence live routing decisions.
 *   help    Show usage.
 */

const DEFAULT_WAL_DIR = "~/.openclaw/model-router/wal";
const DEFAULT_SINCE_DAYS = 7;
const DEFAULT_MIN_CONFIDENCE = 0.70;
const TIER_IDS: readonly TierId[] = ["T0", "T1", "T2", "T3"];

/* ------------------------------------------------------------------- */
/* WAL row shape (read-side, lenient parsing)                          */
/* ------------------------------------------------------------------- */

type ParsedRow = {
  ts: number;
  runId: string;
  promptHash: string;
  promptLen: number;
  tokenCountEstimate: number;
  tierChosen: TierId;
  providerChosen: string;
  modelChosen: string;
  confidence: number;
  classifiers: string[];
  reason: string;
  classifierLatencyMs: number;
  priorTier: TierId | null;
  failoverApplied: boolean;
  routedLive?: boolean;
  originalTier?: TierId;
  kind?: "decision" | "outcome";
};

function isDecisionRow(raw: Record<string, unknown>): raw is ParsedRow {
  return (
    typeof raw.ts === "number" &&
    typeof raw.tierChosen === "string" &&
    (raw.kind === undefined || raw.kind === "decision")
  );
}

/* ------------------------------------------------------------------- */
/* WAL file discovery + parsing                                        */
/* ------------------------------------------------------------------- */

function dateDaysAgo(days: number, now: Date = new Date()): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateFromFilename(filename: string): Date | null {
  const m = filename.match(/decisions-(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!m) {
    return null;
  }
  const d = new Date(m[1] + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

async function discoverWalFiles(
  walDir: string,
  sinceDays: number,
): Promise<string[]> {
  const resolved = expandHome(walDir);
  let entries: string[];
  try {
    entries = await readdir(resolved);
  } catch {
    return [];
  }
  const cutoff = dateDaysAgo(sinceDays);
  return entries
    .filter((e) => {
      const d = dateFromFilename(e);
      return d !== null && d >= cutoff;
    })
    .sort()
    .map((e) => join(resolved, e));
}

async function parseWalFile(path: string): Promise<ParsedRow[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const rows: ParsedRow[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      if (isDecisionRow(raw)) {
        rows.push(raw as unknown as ParsedRow);
      }
    } catch {
      // skip malformed lines
    }
  }
  return rows;
}

export async function loadRows(
  walDir: string,
  sinceDays: number,
): Promise<ParsedRow[]> {
  const files = await discoverWalFiles(walDir, sinceDays);
  const chunks = await Promise.all(files.map(parseWalFile));
  return chunks.flat().sort((a, b) => a.ts - b.ts);
}

/* ------------------------------------------------------------------- */
/* Audit summary                                                        */
/* ------------------------------------------------------------------- */

export type AuditSummary = {
  totalDecisions: number;
  dateRange: { earliest: string; latest: string } | null;
  tierDistribution: Record<TierId, { count: number; pct: string }>;
  failoverRate: { count: number; pct: string };
  liveRoutedRate: { count: number; pct: string };
  classifierBreakdown: Record<string, number>;
  latencyStats: { p50Ms: number; p95Ms: number; p99Ms: number; meanMs: number };
  avgConfidence: number;
  topFailoverPaths: Array<{ from: string; to: string; count: number }>;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function fmtPct(n: number, total: number): string {
  if (total === 0) {
    return "0.0%";
  }
  return ((n / total) * 100).toFixed(1) + "%";
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function computeAudit(rows: ParsedRow[]): AuditSummary {
  const total = rows.length;
  const tierCounts: Record<string, number> = {};
  const classifierCounts: Record<string, number> = {};
  const latencies: number[] = [];
  let failoverCount = 0;
  let liveCount = 0;
  let confSum = 0;
  const failoverPaths = new Map<string, number>();

  for (const r of rows) {
    tierCounts[r.tierChosen] = (tierCounts[r.tierChosen] ?? 0) + 1;
    for (const c of r.classifiers) {
      classifierCounts[c] = (classifierCounts[c] ?? 0) + 1;
    }
    latencies.push(r.classifierLatencyMs);
    confSum += r.confidence;
    if (r.failoverApplied) {
      failoverCount += 1;
      const from = r.originalTier ?? "?";
      const key = `${from}→${r.tierChosen}`;
      failoverPaths.set(key, (failoverPaths.get(key) ?? 0) + 1);
    }
    if (r.routedLive) {
      liveCount += 1;
    }
  }

  latencies.sort((a, b) => a - b);

  const tierDist = {} as Record<TierId, { count: number; pct: string }>;
  for (const t of TIER_IDS) {
    const c = tierCounts[t] ?? 0;
    tierDist[t] = { count: c, pct: fmtPct(c, total) };
  }

  const topPaths = [...failoverPaths.entries()]
    .map(([key, count]) => {
      const [from = "?", to = "?"] = key.split("→");
      return { from, to, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalDecisions: total,
    dateRange:
      total > 0
        ? { earliest: fmtDate(rows[0]!.ts), latest: fmtDate(rows[total - 1]!.ts) }
        : null,
    tierDistribution: tierDist,
    failoverRate: { count: failoverCount, pct: fmtPct(failoverCount, total) },
    liveRoutedRate: { count: liveCount, pct: fmtPct(liveCount, total) },
    classifierBreakdown: classifierCounts,
    latencyStats: {
      p50Ms: Math.round(percentile(latencies, 50) * 100) / 100,
      p95Ms: Math.round(percentile(latencies, 95) * 100) / 100,
      p99Ms: Math.round(percentile(latencies, 99) * 100) / 100,
      meanMs:
        Math.round(
          (latencies.reduce((s, x) => s + x, 0) / Math.max(total, 1)) * 100,
        ) / 100,
    },
    avgConfidence: total > 0 ? Math.round((confSum / total) * 1000) / 1000 : 0,
    topFailoverPaths: topPaths,
  };
}

export function formatAudit(s: AuditSummary): string {
  const lines: string[] = [];
  lines.push("=== Model Router — Audit Summary ===");
  lines.push("");
  lines.push(`Decisions: ${s.totalDecisions}`);
  if (s.dateRange) {
    lines.push(
      `Date range: ${s.dateRange.earliest} to ${s.dateRange.latest}`,
    );
  }
  lines.push("");
  lines.push("Tier distribution:");
  for (const t of TIER_IDS) {
    const d = s.tierDistribution[t];
    lines.push(`  ${t}: ${d.count} (${d.pct})`);
  }
  lines.push("");
  lines.push(
    `Failover rate: ${s.failoverRate.count} / ${s.totalDecisions} (${s.failoverRate.pct})`,
  );
  lines.push(
    `Live-routed: ${s.liveRoutedRate.count} / ${s.totalDecisions} (${s.liveRoutedRate.pct})`,
  );
  if (s.topFailoverPaths.length > 0) {
    lines.push("");
    lines.push("Top failover paths:");
    for (const p of s.topFailoverPaths) {
      lines.push(`  ${p.from}→${p.to}: ${p.count}`);
    }
  }
  lines.push("");
  lines.push("Classifier breakdown:");
  const sorted = Object.entries(s.classifierBreakdown).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [label, count] of sorted) {
    lines.push(`  ${label}: ${count}`);
  }
  lines.push("");
  lines.push("Classifier latency:");
  lines.push(`  p50=${s.latencyStats.p50Ms}ms  p95=${s.latencyStats.p95Ms}ms  p99=${s.latencyStats.p99Ms}ms  mean=${s.latencyStats.meanMs}ms`);
  lines.push(`Average confidence: ${s.avgConfidence}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------- */
/* Exemplars harvest                                                    */
/* ------------------------------------------------------------------- */

export type HarvestedExemplar = {
  promptHash: string;
  tier: TierId;
  confidence: number;
  classifiers: string[];
  reason: string;
  promptLen: number;
};

/**
 * Mine high-confidence, non-failover, live-routed WAL rows as new
 * exemplar candidates. Deduplicates by promptHash (only the highest-
 * confidence occurrence is kept). Operators review + curate before
 * feeding back into `src/classifier/exemplars.ts`.
 */
export function harvestExemplars(
  rows: ParsedRow[],
  minConfidence: number,
): HarvestedExemplar[] {
  const best = new Map<string, HarvestedExemplar>();

  for (const r of rows) {
    if (r.failoverApplied) {
      continue;
    }
    if (r.confidence < minConfidence) {
      continue;
    }
    // Only harvest rows that actually matched a semantic or heuristic
    // signal — skip "no_semantic" default-T1 rows.
    if (
      r.classifiers.length === 1 &&
      r.classifiers[0] === "no_semantic"
    ) {
      continue;
    }
    const existing = best.get(r.promptHash);
    if (existing && existing.confidence >= r.confidence) {
      continue;
    }
    best.set(r.promptHash, {
      promptHash: r.promptHash,
      tier: r.tierChosen,
      confidence: r.confidence,
      classifiers: r.classifiers,
      reason: r.reason,
      promptLen: r.promptLen,
    });
  }

  return [...best.values()].sort((a, b) => b.confidence - a.confidence);
}

export function formatHarvest(
  exemplars: HarvestedExemplar[],
  format: "json" | "tsv",
): string {
  if (format === "json") {
    return JSON.stringify(exemplars, null, 2);
  }
  const header = "promptHash\ttier\tconfidence\tclassifiers\treason\tpromptLen";
  const rows = exemplars.map(
    (e) =>
      `${e.promptHash}\t${e.tier}\t${e.confidence.toFixed(3)}\t${e.classifiers.join(",")}\t${e.reason}\t${e.promptLen}`,
  );
  return [header, ...rows].join("\n");
}

/* ------------------------------------------------------------------- */
/* CLI argument parsing                                                 */
/* ------------------------------------------------------------------- */

function extractArg(
  args: string[],
  prefix: string,
  fallback: string,
): string {
  for (const a of args) {
    if (a.startsWith(prefix)) {
      return a.slice(prefix.length);
    }
  }
  return fallback;
}

function extractNumArg(
  args: string[],
  prefix: string,
  fallback: number,
): number {
  const raw = extractArg(args, prefix, String(fallback));
  const n = Number(raw);
  return isNaN(n) ? fallback : n;
}

function printHelp(): void {
  console.log(`
openclaw model-router CLI

Usage:
  node dist/cli.js <command> [options]

Commands:
  audit      Show routing decision summary from the WAL.
  harvest    Propose new exemplars from high-confidence WAL rows.
  help       Show this help message.

Options (all commands):
  --since=<N>d                Number of days to look back (default: 7).
  --wal-dir=<PATH>            WAL directory (default: ~/.openclaw/model-router/wal).

Options (harvest):
  --min-confidence=<N>        Minimum confidence threshold (default: 0.70).
  --format=json|tsv           Output format (default: tsv).
`.trim());
}

/* ------------------------------------------------------------------- */
/* Main                                                                 */
/* ------------------------------------------------------------------- */

async function main(argv: string[]): Promise<number> {
  const [, , rawCmd = "help", ...rest] = argv;

  if (rawCmd === "help" || rawCmd === "--help" || rawCmd === "-h") {
    printHelp();
    return 0;
  }

  const walDir = extractArg(rest, "--wal-dir=", DEFAULT_WAL_DIR);
  const sinceRaw = extractArg(rest, "--since=", `${DEFAULT_SINCE_DAYS}d`);
  const sinceDays = parseInt(sinceRaw.replace(/d$/i, ""), 10) || DEFAULT_SINCE_DAYS;

  const rows = await loadRows(walDir, sinceDays);

  switch (rawCmd) {
    case "audit": {
      if (rows.length === 0) {
        console.log(
          `No WAL rows found in ${expandHome(walDir)} for the last ${sinceDays} day(s).`,
        );
        return 0;
      }
      const summary = computeAudit(rows);
      console.log(formatAudit(summary));
      return 0;
    }
    case "harvest": {
      if (rows.length === 0) {
        console.log(
          `No WAL rows found in ${expandHome(walDir)} for the last ${sinceDays} day(s).`,
        );
        return 0;
      }
      const minConf = extractNumArg(rest, "--min-confidence=", DEFAULT_MIN_CONFIDENCE);
      const fmt = extractArg(rest, "--format=", "tsv") as "json" | "tsv";
      const exemplars = harvestExemplars(rows, minConf);
      if (exemplars.length === 0) {
        console.log(
          `No exemplar candidates found above confidence ${minConf} in ${rows.length} decision(s).`,
        );
        return 0;
      }
      console.log(formatHarvest(exemplars, fmt));
      console.error(
        `\n${exemplars.length} exemplar candidate(s) harvested from ${rows.length} decision(s) (min confidence=${minConf}).`,
      );
      return 0;
    }
    default:
      console.error(`Unknown command: ${rawCmd}`);
      printHelp();
      return 2;
  }
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("/cli.js") || process.argv[1].endsWith("/cli.ts"));

if (isDirectRun) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error("Fatal:", err);
      process.exit(1);
    },
  );
}
