import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ObservabilityConfig, TierId } from "./config.js";
import type { Logger } from "./logger.js";
import { ensureDir, expandHome, todayStamp } from "./paths.js";
import type { ClassifierLabel } from "./classifier/types.js";

/**
 * Routing decision row. One per `before_model_resolve` invocation.
 *
 * Schema mirrors DESIGN.md §8 exactly. Every field is structured (no free-form
 * pretty-printed strings except `reason`) so an `openclaw model-router audit`
 * CLI (Step 9) can group/sort/aggregate without parsing prose.
 */
export type DecisionRow = {
  /** Unix epoch milliseconds at decision time. */
  ts: number;
  /** Agent run id from PluginHookAgentContext. May be empty for cold runs. */
  runId: string;
  /** "sha256:" + hex(64) of the normalized prompt. Never the raw prompt. */
  promptHash: string;
  /** Character length of the original (un-normalized) prompt. */
  promptLen: number;
  /** Approximate token count via the inlined CJK-aware estimator. */
  tokenCountEstimate: number;
  /** Tier the decider picked. */
  tierChosen: TierId;
  /** Provider string from cfg.tiers[tierChosen].provider. */
  providerChosen: string;
  /** Model string from cfg.tiers[tierChosen].model. */
  modelChosen: string;
  /** Decider confidence in [0, 1]. */
  confidence: number;
  /** Provenance labels — which classifiers contributed to this decision. */
  classifiers: ClassifierLabel[];
  /** Human-readable reason; surfaced in audit reports. */
  reason: string;
  /** Wall-clock time spent in heuristic + semantic classification. */
  classifierLatencyMs: number;
  /** Tier picked on the previous turn of this conversation, if known. */
  priorTier: TierId | null;
  /** Whether failover.ts substituted the picked tier with a different one. */
  failoverApplied: boolean;
};

/**
 * Outcome row written on `model_call_ended`. Joined to the matching
 * DecisionRow by `runId` during offline analysis. Kept structurally distinct
 * (different field set, no `tierChosen`) so the CLI can
 * `grep '"kind":"outcome"'` to filter quickly.
 *
 * NOTE: chose `model_call_ended` over `agent_end` deliberately — `agent_end`
 * is a CONVERSATION_HOOK and OpenClaw blocks non-bundled plugins from
 * subscribing to it without an explicit `hooks.allowConversationAccess=true`
 * config opt-in. `model_call_ended` carries the same success/duration
 * signals (and adds per-call provider/model metadata useful for verifying
 * Step 7's overrides actually landed) without the privacy concern.
 *
 * Schema is a small superset of DESIGN.md §8 — we record the actual
 * `provider`/`model` strings from the upstream call so an audit can prove
 * that the router's `modelOverride` made it through (or was overridden by
 * a higher-priority plugin).
 */
export type OutcomeRow = {
  ts: number;
  runId: string;
  /** Per-call unique id from PluginHookModelCallBaseEvent. */
  callId: string;
  /** Discriminant — "decision" | "outcome". DecisionRow omits this for
   *  back-compat with the §8 schema; a missing `kind` field implies
   *  "decision". */
  kind: "outcome";
  /** "completed" | "error" — directly from PluginHookModelCallEndedEvent. */
  outcome: "completed" | "error";
  /** Provider string the gateway actually called. */
  provider: string;
  /** Model string the gateway actually called. */
  model: string;
  durationMs: number;
  /** Optional latency breakdown — present for streaming-capable providers. */
  timeToFirstByteMs?: number;
  errorCategory?: string;
  failureKind?: string;
};

type WalRow = (DecisionRow & { kind?: "decision" }) | OutcomeRow;

/**
 * Append-only JSONL audit log. Daily-rotated, `~`-expanded path, sampled by
 * `observability.sampleRate`, fail-soft on filesystem errors so a full disk
 * never crashes the gateway.
 *
 * Concurrency: `appendFile` with `flag: "a"` is atomic for writes < 4KB on
 * POSIX (per write(2) PIPE_BUF guarantee). Each row is well under that
 * limit, so concurrent appends from parallel `before_model_resolve`
 * invocations interleave at row boundaries without corruption.
 *
 * Lifecycle:
 *   1. Constructor — pure; no I/O.
 *   2. init() — creates the WAL directory; called once during
 *      gateway_start so failures surface in boot logs, not first request.
 *   3. append(row) — fire-and-forget. Returns a Promise that callers MAY
 *      await but are not required to; rejection is logged-and-swallowed.
 *   4. close() — currently a no-op (Node's fs handles flush on process
 *      exit). Reserved for future buffered-write modes.
 */
export class DecisionWAL {
  private readonly cfg: ObservabilityConfig;
  private readonly logger: Logger;
  private readonly resolvedDir: string;
  /** True after init(); blocks appends from racing the directory creation. */
  private ready = false;
  /** Suppresses log spam when the FS is repeatedly failing (e.g. disk full). */
  private failureCountInWindow = 0;
  private failureWindowStart = 0;
  /** Tunable so tests can pin time-of-day for daily-rotation assertions. */
  private readonly nowFn: () => Date;

  constructor(cfg: ObservabilityConfig, logger: Logger, nowFn: () => Date = () => new Date()) {
    this.cfg = cfg;
    this.logger = logger;
    this.resolvedDir = expandHome(cfg.walDir);
    this.nowFn = nowFn;
  }

  /**
   * Create the WAL directory. Should be called from `gateway_start` so any
   * permission / volume issues surface in boot logs rather than at the
   * first user request.
   */
  async init(): Promise<void> {
    if (!this.cfg.logDecisions) {
      this.logger.info(
        "model-router: WAL disabled via observability.logDecisions=false (no rows will be written)",
      );
      this.ready = true;
      return;
    }
    try {
      await ensureDir(this.resolvedDir);
      this.ready = true;
      this.logger.info(`model-router: WAL ready at ${this.resolvedDir} (sample=${this.cfg.sampleRate})`);
    } catch (err) {
      this.logger.error(
        `model-router: failed to create WAL directory ${this.resolvedDir}: ${String(err)} — WAL writes will be dropped silently`,
      );
      this.ready = false;
    }
  }

  /**
   * Append a decision row. Returns the written path on success, undefined
   * if dropped (sampling, disabled, init failure, FS error). Never throws.
   */
  async appendDecision(row: DecisionRow): Promise<string | undefined> {
    return this.append({ ...row, kind: "decision" });
  }

  /**
   * Append an outcome row. Same semantics as appendDecision.
   */
  async appendOutcome(row: OutcomeRow): Promise<string | undefined> {
    return this.append(row);
  }

  /**
   * Reserved for future buffered-write modes. Currently a no-op because
   * each appendFile() is its own sync-to-disk-on-success operation.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    // No buffered state to flush in v0.1. Method exists so callers
    // (gateway_stop) don't have to special-case the early lifecycle.
  }

  /**
   * Compute the current WAL file path. Public for tests and the audit CLI
   * (Step 9). Date is recomputed on every call so the file rotates at
   * midnight without explicit reopen logic.
   */
  filePathForNow(): string {
    return join(this.resolvedDir, `decisions-${todayStamp(this.nowFn())}.jsonl`);
  }

  /**
   * Compute the canonical sha256 hash of a prompt for the WAL row. Public
   * so tests can verify normalization is stable across releases (changing
   * normalization breaks join-by-hash analysis on old logs).
   *
   * Normalization:
   *   - Convert CRLF / CR line endings to LF.
   *   - Strip leading and trailing whitespace.
   *   - Preserve case (case is semantically meaningful in code prompts).
   */
  static hashPrompt(text: string): string {
    const normalized = text.replace(/\r\n?/g, "\n").trim();
    const hex = createHash("sha256").update(normalized, "utf8").digest("hex");
    return `sha256:${hex}`;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async append(row: WalRow): Promise<string | undefined> {
    if (!this.ready || !this.cfg.logDecisions) {
      return undefined;
    }
    if (this.cfg.sampleRate < 1.0 && Math.random() >= this.cfg.sampleRate) {
      return undefined;
    }
    const path = this.filePathForNow();
    const line = JSON.stringify(row) + "\n";
    try {
      await appendFile(path, line, { encoding: "utf8" });
      return path;
    } catch (err) {
      this.recordFailure(err);
      return undefined;
    }
  }

  /**
   * Log filesystem failures with rate-limiting. A misconfigured walDir or
   * a full disk can produce thousands of failures per second; logging each
   * one would amplify the outage. Cap at one log line per minute.
   */
  private recordFailure(err: unknown): void {
    const nowMs = this.nowFn().getTime();
    const ONE_MINUTE_MS = 60_000;
    if (nowMs - this.failureWindowStart > ONE_MINUTE_MS) {
      this.failureWindowStart = nowMs;
      this.failureCountInWindow = 1;
      this.logger.warn(
        `model-router: WAL append failed (${String(err)}) — further failures suppressed for 60s`,
      );
      return;
    }
    this.failureCountInWindow += 1;
  }
}
