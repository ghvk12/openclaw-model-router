import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DecisionWAL, type DecisionRow, type OutcomeRow } from "../src/decision-wal.js";
import type { ObservabilityConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";

/**
 * WAL writer tests. Use a real temp directory so we exercise the actual
 * filesystem code path (mkdir, appendFile, JSONL parse round-trip), not a
 * mock — the failure mode this protects against is "writes succeed in
 * tests but fail in prod due to a path-handling bug."
 *
 * Each test creates its own temp dir to avoid cross-test contamination
 * from sampling, daily rotation, and concurrent appends.
 */

let tempDir: string;
let logger: Logger;
const logCalls: { level: string; msg: string }[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "model-router-wal-"));
  logCalls.length = 0;
  logger = {
    info: (msg: string) => {
      logCalls.push({ level: "info", msg });
    },
    warn: (msg: string) => {
      logCalls.push({ level: "warn", msg });
    },
    error: (msg: string) => {
      logCalls.push({ level: "error", msg });
    },
  };
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function baseCfg(overrides: Partial<ObservabilityConfig> = {}): ObservabilityConfig {
  return {
    walDir: tempDir,
    logDecisions: true,
    sampleRate: 1.0,
    ...overrides,
  };
}

function sampleDecisionRow(): DecisionRow {
  return {
    ts: 1745923011000,
    runId: "run-abc-123",
    promptHash: DecisionWAL.hashPrompt("hello world"),
    promptLen: 11,
    tokenCountEstimate: 3,
    tierChosen: "T1",
    providerChosen: "deepseek",
    modelChosen: "deepseek-v4-flash",
    confidence: 0.5,
    classifiers: ["heuristic_default"],
    reason: "stub decider (always T1) — heuristic: neutral",
    classifierLatencyMs: 0.42,
    priorTier: null,
    failoverApplied: false,
  };
}

describe("DecisionWAL — hashPrompt", () => {
  it("emits 'sha256:' prefix + 64 hex chars", () => {
    const h = DecisionWAL.hashPrompt("hello");
    expect(h, "should start with sha256:").toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("normalizes CRLF / CR to LF before hashing", () => {
    const lf = DecisionWAL.hashPrompt("a\nb\nc");
    const crlf = DecisionWAL.hashPrompt("a\r\nb\r\nc");
    const cr = DecisionWAL.hashPrompt("a\rb\rc");
    expect(crlf, "CRLF should hash same as LF").toBe(lf);
    expect(cr, "CR should hash same as LF").toBe(lf);
  });

  it("trims leading and trailing whitespace before hashing", () => {
    const tight = DecisionWAL.hashPrompt("hello world");
    const padded = DecisionWAL.hashPrompt("   \n  hello world  \n  ");
    expect(padded, "leading/trailing whitespace should not affect hash").toBe(tight);
  });

  it("preserves case (case is semantically meaningful in code prompts)", () => {
    const lower = DecisionWAL.hashPrompt("foo");
    const upper = DecisionWAL.hashPrompt("FOO");
    expect(upper, "case should change the hash").not.toBe(lower);
  });

  it("is deterministic across calls", () => {
    const a = DecisionWAL.hashPrompt("the same prompt");
    const b = DecisionWAL.hashPrompt("the same prompt");
    expect(a).toBe(b);
  });
});

describe("DecisionWAL — init / fail-soft", () => {
  it("creates the WAL directory when missing", async () => {
    const nested = join(tempDir, "nested", "wal");
    const wal = new DecisionWAL(baseCfg({ walDir: nested }), logger);
    await wal.init();
    expect(
      logCalls.some((c) => c.msg.includes("WAL ready at")),
      "should log 'WAL ready at <path>' on success",
    ).toBe(true);
    const written = await wal.appendDecision(sampleDecisionRow());
    expect(written, "append should succeed once init created the dir").toBeDefined();
  });

  it("logs init failure but does NOT throw when walDir cannot be created", async () => {
    // Using /dev/null as a parent guarantees mkdir fails on macOS/Linux.
    const wal = new DecisionWAL(baseCfg({ walDir: "/dev/null/cannot-exist" }), logger);
    await expect(wal.init(), "init should never throw").resolves.toBeUndefined();
    expect(
      logCalls.some(
        (c) => c.level === "error" && c.msg.includes("failed to create WAL directory"),
      ),
      "should log an error explaining the failure",
    ).toBe(true);
  });

  it("returns undefined from append when init failed (drops silently)", async () => {
    const wal = new DecisionWAL(baseCfg({ walDir: "/dev/null/cannot-exist" }), logger);
    await wal.init();
    const written = await wal.appendDecision(sampleDecisionRow());
    expect(written, "append should drop silently when not ready").toBeUndefined();
  });

  it("is a no-op when logDecisions=false", async () => {
    const wal = new DecisionWAL(baseCfg({ logDecisions: false }), logger);
    await wal.init();
    const written = await wal.appendDecision(sampleDecisionRow());
    expect(written, "append should drop when logDecisions=false").toBeUndefined();
    expect(
      logCalls.some((c) => c.msg.includes("WAL disabled via observability")),
      "should log a single 'disabled' line at init",
    ).toBe(true);
  });
});

describe("DecisionWAL — append (decision rows)", () => {
  it("writes a single newline-terminated JSON line per append", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    const path = await wal.appendDecision(sampleDecisionRow());
    expect(path, "append should return the file path on success").toBeDefined();

    const contents = await readFile(path!, "utf8");
    expect(contents, "should end with a newline").toMatch(/\n$/);
    const lines = contents.trim().split("\n");
    expect(lines, "single append → single line").toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.tierChosen, "tierChosen should round-trip").toBe("T1");
    expect(parsed.kind, "DecisionWAL.appendDecision tags rows with kind=decision").toBe(
      "decision",
    );
  });

  it("appends multiple rows in order without overwriting", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    const r1 = { ...sampleDecisionRow(), runId: "run-1" };
    const r2 = { ...sampleDecisionRow(), runId: "run-2" };
    const r3 = { ...sampleDecisionRow(), runId: "run-3" };
    await wal.appendDecision(r1);
    await wal.appendDecision(r2);
    await wal.appendDecision(r3);

    const path = wal.filePathForNow();
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).runId).toBe("run-1");
    expect(JSON.parse(lines[1]).runId).toBe("run-2");
    expect(JSON.parse(lines[2]).runId).toBe("run-3");
  });

  it("survives concurrent appends without corrupting JSONL", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ...sampleDecisionRow(),
      runId: `concurrent-${i}`,
    }));
    await Promise.all(rows.map((r) => wal.appendDecision(r)));

    const lines = (await readFile(wal.filePathForNow(), "utf8")).trim().split("\n");
    expect(lines, "all 50 rows should be present").toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line), "every line should parse cleanly").not.toThrow();
    }
    const ids = new Set(lines.map((l) => JSON.parse(l).runId));
    expect(ids.size, "no rows should be duplicated or lost").toBe(50);
  });
});

function sampleOutcomeRow(): OutcomeRow {
  return {
    ts: 1745923012000,
    runId: "run-xyz",
    callId: "call-001",
    kind: "outcome",
    outcome: "completed",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    durationMs: 1234,
    timeToFirstByteMs: 87,
  };
}

describe("DecisionWAL — append (outcome rows)", () => {
  it("writes outcome rows with kind=outcome and call metadata", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    const path = await wal.appendOutcome(sampleOutcomeRow());
    const contents = await readFile(path!, "utf8");
    const parsed = JSON.parse(contents.trim());
    expect(parsed.kind).toBe("outcome");
    expect(parsed.runId).toBe("run-xyz");
    expect(parsed.callId, "callId should round-trip").toBe("call-001");
    expect(parsed.outcome).toBe("completed");
    expect(parsed.provider, "provider should round-trip").toBe("deepseek");
    expect(parsed.model, "model should round-trip").toBe("deepseek-v4-flash");
    expect(parsed.durationMs).toBe(1234);
    expect(parsed.timeToFirstByteMs).toBe(87);
  });

  it("does NOT include conversation-derived fields (success has no field, no messages, no error text)", async () => {
    // Privacy contract: the OutcomeRow type is metadata-only. This test
    // pins the row shape so a future refactor that adds e.g. `error` (raw
    // string) or `messages` (array) trips before it ships.
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    const path = await wal.appendOutcome(sampleOutcomeRow());
    const parsed = JSON.parse((await readFile(path!, "utf8")).trim());
    const allowed = new Set([
      "ts",
      "runId",
      "callId",
      "kind",
      "outcome",
      "provider",
      "model",
      "durationMs",
      "timeToFirstByteMs",
      "errorCategory",
      "failureKind",
    ]);
    for (const key of Object.keys(parsed)) {
      expect(allowed.has(key), `unexpected field '${key}' in outcome row`).toBe(true);
    }
  });

  it("interleaves decision and outcome rows in the same file", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    await wal.appendDecision({ ...sampleDecisionRow(), runId: "r1" });
    await wal.appendOutcome({ ...sampleOutcomeRow(), runId: "r1" });
    const lines = (await readFile(wal.filePathForNow(), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe("decision");
    expect(JSON.parse(lines[1]).kind).toBe("outcome");
  });
});

describe("DecisionWAL — sampling", () => {
  it("drops ~all rows when sampleRate=0", async () => {
    const wal = new DecisionWAL(baseCfg({ sampleRate: 0 }), logger);
    await wal.init();
    for (let i = 0; i < 20; i++) {
      await wal.appendDecision(sampleDecisionRow());
    }
    const path = wal.filePathForNow();
    // File may not exist at all if no writes happened — both outcomes acceptable.
    let contents = "";
    try {
      contents = await readFile(path, "utf8");
    } catch {
      // ENOENT is fine — no writes happened, no file created.
    }
    expect(contents, "with sampleRate=0, no rows should land").toBe("");
  });

  it("keeps ~all rows when sampleRate=1.0", async () => {
    const wal = new DecisionWAL(baseCfg({ sampleRate: 1.0 }), logger);
    await wal.init();
    for (let i = 0; i < 20; i++) {
      await wal.appendDecision({ ...sampleDecisionRow(), runId: `r${i}` });
    }
    const lines = (await readFile(wal.filePathForNow(), "utf8")).trim().split("\n");
    expect(lines, "sampleRate=1.0 should retain every row").toHaveLength(20);
  });

  it("statistically respects sampleRate=0.5 (rough)", async () => {
    const wal = new DecisionWAL(baseCfg({ sampleRate: 0.5 }), logger);
    await wal.init();
    const N = 400;
    for (let i = 0; i < N; i++) {
      await wal.appendDecision({ ...sampleDecisionRow(), runId: `r${i}` });
    }
    let count = 0;
    try {
      const contents = await readFile(wal.filePathForNow(), "utf8");
      count = contents.trim().split("\n").filter((l) => l.length > 0).length;
    } catch {
      // file may legitimately not exist if every roll missed
    }
    // Wide tolerance band: 2σ for binomial(400, 0.5) is ~±20.
    expect(count, `expected ~200/400 rows with sampleRate=0.5, got ${count}`).toBeGreaterThan(
      150,
    );
    expect(count).toBeLessThan(250);
  });
});

describe("DecisionWAL — daily rotation", () => {
  it("filePathForNow uses today's local YYYY-MM-DD", () => {
    const fakeNow = new Date(2026, 4, 1); // 2026-05-01 (month is 0-indexed)
    const wal = new DecisionWAL(baseCfg(), logger, () => fakeNow);
    const path = wal.filePathForNow();
    expect(path).toContain("decisions-2026-05-01.jsonl");
  });

  it("rotates when the day changes between appends", async () => {
    let now = new Date(2026, 4, 1, 23, 59, 30);
    const wal = new DecisionWAL(baseCfg(), logger, () => now);
    await wal.init();
    await wal.appendDecision({ ...sampleDecisionRow(), runId: "before-midnight" });
    now = new Date(2026, 4, 2, 0, 0, 5);
    await wal.appendDecision({ ...sampleDecisionRow(), runId: "after-midnight" });

    const file1 = await readFile(join(tempDir, "decisions-2026-05-01.jsonl"), "utf8");
    const file2 = await readFile(join(tempDir, "decisions-2026-05-02.jsonl"), "utf8");
    expect(JSON.parse(file1.trim()).runId).toBe("before-midnight");
    expect(JSON.parse(file2.trim()).runId).toBe("after-midnight");
  });
});

describe("DecisionWAL — lazy init (regression: --local mode never fires gateway_start)", () => {
  it("appends successfully without an explicit init() call", async () => {
    // Simulates the embedded `--local` agent runner that does NOT fire
    // gateway_start. Step 4 originally relied on gateway_start to call
    // init() before any append() — that silently dropped every WAL row
    // in --local mode.
    const wal = new DecisionWAL(baseCfg(), logger);
    const path = await wal.appendDecision(sampleDecisionRow());
    expect(path, "lazy init should let the first append succeed").toBeDefined();
    const contents = await readFile(path!, "utf8");
    expect(contents, "row should land on disk").toContain('"runId":"run-abc-123"');
    expect(
      logCalls.some((c) => c.msg.includes("WAL ready at")),
      "lazy init should still log the readiness message",
    ).toBe(true);
  });

  it("only logs 'WAL ready' once across many concurrent first-time appends", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        wal.appendDecision({ ...sampleDecisionRow(), runId: `concurrent-${i}` }),
      ),
    );
    const readyLogs = logCalls.filter((c) => c.msg.includes("WAL ready at"));
    expect(
      readyLogs.length,
      "single-flight init should log readiness exactly once",
    ).toBe(1);
  });

  it("an explicit init() after a lazy init is a no-op (idempotent)", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.appendDecision(sampleDecisionRow()); // triggers lazy init
    await expect(
      wal.init(),
      "explicit init after lazy init should resolve cleanly",
    ).resolves.toBeUndefined();
    const readyLogs = logCalls.filter((c) => c.msg.includes("WAL ready at"));
    expect(readyLogs.length, "init should not double-log readiness").toBe(1);
  });
});

describe("DecisionWAL — close", () => {
  it("close() is a no-op that doesn't throw on a fresh WAL", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await expect(wal.close(), "close on never-initialized WAL").resolves.toBeUndefined();
  });

  it("close() is idempotent after init + appends", async () => {
    const wal = new DecisionWAL(baseCfg(), logger);
    await wal.init();
    await wal.appendDecision(sampleDecisionRow());
    await expect(wal.close()).resolves.toBeUndefined();
    await expect(wal.close(), "second close should also be a no-op").resolves.toBeUndefined();
  });
});
