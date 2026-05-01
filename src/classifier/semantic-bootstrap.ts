import type { ResolvedConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createEmbedder } from "./embedder.js";
import { RouterQdrantClient } from "./qdrant-router.js";
import { seedExemplars } from "./seed-exemplars.js";
import type { SemanticDeps } from "./semantic.js";

/**
 * Lazy single-flight bootstrap for the semantic classifier.
 *
 * BACKGROUND — why this isn't just called once at gateway_start:
 *   The OpenClaw runtime instantiates the plugin in two distinct
 *   process lifecycles:
 *     1. The long-lived gateway daemon (LaunchAgent / systemd):
 *        gateway_start fires once, then before_model_resolve fires
 *        many times over the daemon's lifetime.
 *     2. Per-invocation `openclaw agent` CLI processes (and similar
 *        short-lived hosts): each invocation re-loads the plugin
 *        and fires before_model_resolve, but gateway_start is NOT
 *        emitted — the closure-default `runtime.semanticDeps = null`
 *        therefore stays null forever, silently disabling the
 *        semantic classifier in those processes.
 *
 *   The original Step 5 wiring assumed lifecycle (1) and broke for
 *   lifecycle (2) — discovered by smoke test in Step 6e (every WAL
 *   row showed `["no_semantic"]`). This module is the fix.
 *
 * BEHAVIOUR:
 *   - `ensureReady()` performs the bootstrap (Ollama probe → Qdrant
 *     ensureCollection → seedExemplars). Awaitable; returns the deps
 *     or null on failure. Single-flight — concurrent callers share
 *     the same in-flight promise.
 *   - `kickoff()` fires `ensureReady()` and discards the result —
 *     safe to call from the request path without blocking. Ideal
 *     for the `before_model_resolve` hook (the first request pays
 *     no latency; subsequent requests see semantic kick in once the
 *     bootstrap settles).
 *   - `deps()` returns the synchronously-readable current state —
 *     null until bootstrap completes, then the deps for the rest of
 *     the process lifetime.
 *
 * FAILURE POLICY (DESIGN.md §10):
 *   - On bootstrap failure (Ollama unreachable, Qdrant down, etc.),
 *     log once at error level, mark `attempted` permanently, and
 *     continue returning null. We do NOT retry per-request because
 *     a recurring outage would create an N-per-request log storm
 *     and pile up failed network attempts on the hot path.
 *   - Operators who fix the underlying outage need to bounce the
 *     gateway / re-run the CLI to retry. This is the same fail-fast
 *     contract the WAL writer uses.
 */
export class SemanticBootstrap {
  private state:
    | { kind: "uninitialized" }
    | { kind: "in-flight"; promise: Promise<SemanticDeps | null> }
    | { kind: "ready"; deps: SemanticDeps }
    | { kind: "disabled" }
    | { kind: "failed" } = { kind: "uninitialized" };

  constructor(
    private readonly cfg: ResolvedConfig,
    private readonly logger: Logger,
    /** Injection seam for tests — defaults to the production bootstrap. */
    private readonly bootstrapImpl: (
      cfg: ResolvedConfig,
      logger: Logger,
    ) => Promise<SemanticDeps | null> = bootstrapSemanticClassifier,
  ) {
    if (!cfg.classifier.semantic.enabled) {
      this.state = { kind: "disabled" };
    }
  }

  /** Synchronous read. Null until bootstrap completes (or forever if
   *  semantic is disabled / bootstrap failed). Never throws. */
  deps(): SemanticDeps | null {
    return this.state.kind === "ready" ? this.state.deps : null;
  }

  /** True once a bootstrap attempt has been made (succeeded, failed,
   *  in-flight, or skipped because semantic is disabled). Useful for
   *  tests and for the gateway_start eager wait. */
  attempted(): boolean {
    return this.state.kind !== "uninitialized";
  }

  /**
   * Awaitable bootstrap. Idempotent + single-flight: concurrent
   * callers share the same promise; subsequent callers after success
   * get the cached result without re-running the bootstrap. After a
   * failure, returns null without retrying.
   */
  async ensureReady(): Promise<SemanticDeps | null> {
    if (this.state.kind === "ready") {
      return this.state.deps;
    }
    if (this.state.kind === "disabled" || this.state.kind === "failed") {
      return null;
    }
    if (this.state.kind === "in-flight") {
      return this.state.promise;
    }

    const promise = this.runBootstrap();
    this.state = { kind: "in-flight", promise };
    return promise;
  }

  /**
   * Fire-and-forget kickoff — safe from the request hot path. Starts
   * the bootstrap if it hasn't run yet; returns immediately. The
   * caller's request continues without waiting; subsequent requests
   * (after the bootstrap settles) will see semantic deps available.
   *
   * The discarded promise is `.catch`-ed inline so it never produces
   * an unhandledRejection — bootstrap errors are already logged
   * inside `runBootstrap`.
   */
  kickoff(): void {
    if (this.state.kind !== "uninitialized") {
      return;
    }
    void this.ensureReady().catch(() => {
      // Already logged in runBootstrap; swallow to avoid unhandledRejection.
    });
  }

  private async runBootstrap(): Promise<SemanticDeps | null> {
    try {
      const deps = await this.bootstrapImpl(this.cfg, this.logger);
      if (deps === null) {
        this.state = { kind: "failed" };
        return null;
      }
      this.state = { kind: "ready", deps };
      return deps;
    } catch (err) {
      this.logger.error(
        `model-router: semantic bootstrap threw — falling back to heuristic-only routing for this process: ${String(err)}`,
      );
      this.state = { kind: "failed" };
      return null;
    }
  }
}

/**
 * Probe Ollama, ensure the Qdrant collection exists, embed + upload
 * the seed exemplars (if needed), and return SemanticDeps that the
 * `decide()` orchestrator can use for runtime semantic classification.
 *
 * Returns null on any handled failure; never throws (the SemanticBootstrap
 * wrapper still has a try/catch as defence-in-depth, but production
 * code should keep returning null here so the wrapper's `failed`
 * state distinguishes "bootstrap ran and decided null" from "bootstrap
 * threw unexpectedly").
 */
export async function bootstrapSemanticClassifier(
  cfg: ResolvedConfig,
  logger: Logger,
): Promise<SemanticDeps | null> {
  try {
    const embedder = createEmbedder(cfg.classifier.semantic.embeddings, logger);
    const probe = await embedder.probe();
    if (!probe.ok) {
      logger.warn(
        `model-router: Ollama probe failed (${probe.reason ?? "unknown"}) — semantic classifier disabled for this process`,
      );
      return null;
    }
    const qdrant = new RouterQdrantClient(
      cfg.classifier.semantic,
      cfg.classifier.semantic.embeddings.dim,
      logger,
    );
    const result = await seedExemplars(embedder, qdrant, logger);
    if (result.status === "skipped") {
      logger.info(
        `model-router: semantic classifier ready (collection=${cfg.classifier.semantic.qdrant.collection}, exemplars=${result.existingCount}, source=existing)`,
      );
    } else {
      logger.info(
        `model-router: semantic classifier ready (collection=${cfg.classifier.semantic.qdrant.collection}, exemplars=${result.pointsWritten}, source=fresh-seed, durationMs=${result.durationMs.toFixed(0)})`,
      );
    }
    return { embedder, qdrant };
  } catch (err) {
    logger.error(
      `model-router: semantic classifier bootstrap failed — falling back to heuristic-only routing: ${String(err)}`,
    );
    return null;
  }
}
