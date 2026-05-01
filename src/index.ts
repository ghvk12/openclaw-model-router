import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { adoptLogger, type Logger } from "./logger.js";
import { resolveConfig, summarizeConfig, type ResolvedConfig } from "./config.js";
import { runHeuristics } from "./classifier/heuristics.js";
import { stubDecide } from "./decider-stub.js";
import { DecisionWAL, type DecisionRow } from "./decision-wal.js";
import { estimateTokens } from "./tokens.js";
import { createEmbedder } from "./classifier/embedder.js";
import { RouterQdrantClient } from "./classifier/qdrant-router.js";
import { seedExemplars } from "./classifier/seed-exemplars.js";

/**
 * Step 4 (per DESIGN.md §15): observability before behavior change.
 *
 * The plugin now produces a real RoutingDecision per turn (via the stub
 * decider that always returns T1) and writes the decision row to a
 * daily-rotated JSONL WAL. The actual `modelOverride` is still undefined —
 * gateway behavior is identical to the plugin being uninstalled, but
 * operators can now see *what the router would do* via the WAL audit log
 * before any real routing goes live (Step 7).
 *
 * What's new vs Step 3:
 *   - `before_model_resolve` runs heuristics + stub decider + WAL append
 *     on every request.
 *   - `agent_end` writes a follow-up outcome row keyed by runId so offline
 *     analysis can join "decision X led to outcome Y".
 *   - `gateway_start` initializes the WAL directory.
 *   - `gateway_stop` calls `wal.close()` (no-op today, future-proofed).
 *
 * The WAL writer is fail-soft: a misconfigured `walDir`, full disk, or
 * permission error logs once and drops subsequent writes silently — the
 * gateway itself never crashes from a routing-audit failure.
 */

const HOOK_PRIORITY = 100;

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description:
    "Tiered model router for OpenClaw — picks the cheapest sufficient model per turn.",
  register(api: OpenClawPluginApi) {
    const logger = adoptLogger(api.logger as Parameters<typeof adoptLogger>[0]);

    let cfg: ResolvedConfig;
    try {
      cfg = resolveConfig(readRawConfig(api));
    } catch (err) {
      logger.error(`model-router: invalid config — refusing to register: ${String(err)}`);
      throw err;
    }

    const wal = new DecisionWAL(cfg.observability, logger);

    api.on(
      "before_model_resolve",
      async (event, _ctx) => {
        if (!cfg.enabled) {
          return undefined;
        }

        // Classify + decide. Wrapped so a bug here can never break the
        // request — the gateway gets `undefined` (no override) on any
        // throw, identical to having the plugin uninstalled.
        try {
          const t0 = performance.now();
          const heuristic = runHeuristics(event.prompt ?? "", cfg.classifier.heuristics);
          const decision = stubDecide(heuristic, cfg);
          const classifierLatencyMs = performance.now() - t0;

          const tier = cfg.tiers[decision.tier];
          const row: DecisionRow = {
            ts: Date.now(),
            runId: _ctx.runId ?? "",
            promptHash: DecisionWAL.hashPrompt(event.prompt ?? ""),
            promptLen: (event.prompt ?? "").length,
            tokenCountEstimate: estimateTokens(event.prompt ?? ""),
            tierChosen: decision.tier,
            providerChosen: tier.provider,
            modelChosen: tier.model,
            confidence: decision.confidence,
            classifiers: decision.classifiers,
            reason: decision.reason,
            classifierLatencyMs,
            priorTier: null,
            failoverApplied: false,
          };

          // Fire-and-forget — never await. A slow disk shouldn't add
          // latency to the user request. WAL is best-effort observability,
          // not on the critical path.
          void wal.appendDecision(row);
        } catch (err) {
          logger.warn(
            `model-router: classifier/WAL failure (request continues unaffected): ${String(err)}`,
          );
        }

        // Step 4 still no-ops on routing — Step 7 wires the real override.
        return undefined;
      },
      { priority: HOOK_PRIORITY },
    );

    // NOTE: outcome-row subscription (model_call_ended) is intentionally
    // deferred to Step 8 (failover circuit breaker), per DESIGN.md §15.
    // Step 4's scope is "decision-wal.ts + stub decider" only — decision
    // rows give us "real-traffic JSONL" without needing per-call latency,
    // and waiting until Step 8 lets us add version-aware subscription logic
    // (the live gateway 2026.4.24 doesn't yet expose model_call_ended to
    // non-bundled plugins; only 2026.4.26+ does — see DESIGN.md §11).
    // The `OutcomeRow` type and `wal.appendOutcome` method are already in
    // place for Step 8 to wire up.

    api.on("gateway_start", async (_event, _ctx) => {
      await wal.init();

      // Bootstrap the semantic classifier's exemplar collection if (a)
      // semantic is enabled in config and (b) Ollama + Qdrant are
      // reachable. Failure is fail-soft: log loudly and continue with
      // the heuristic-only classifier (which Step 4 already wires).
      // Decision logic (Step 6) will fall back to T1 when the semantic
      // classifier isn't ready.
      if (cfg.classifier.semantic.enabled) {
        await bootstrapSemanticClassifier(cfg, logger);
      } else {
        logger.info(
          "model-router: semantic classifier disabled via config — skipping Qdrant bootstrap",
        );
      }

      logRouterReady(logger, cfg);
    });

    api.on("gateway_stop", async (_event, _ctx) => {
      await wal.close();
      logger.info("model-router: gateway_stop received — WAL closed");
    });

    logger.info(
      `model-router: registered before_model_resolve@priority=${HOOK_PRIORITY} (enabled=${cfg.enabled})`,
    );
  },
});

/**
 * Tolerant config reader. Memory-rag uses the same defensive shape
 * (api.pluginConfig vs api.config.<pluginKey>) because OpenClaw's config
 * surface has migrated across releases — the loose lookup keeps the plugin
 * working across minor SDK versions without tightening to a private type.
 */
function readRawConfig(api: OpenClawPluginApi): unknown {
  const apiObj = api as unknown as Record<string, unknown>;
  return (
    api.pluginConfig ??
    (apiObj.config as Record<string, unknown> | undefined)?.modelRouter ??
    {}
  );
}

function logRouterReady(logger: Logger, cfg: ResolvedConfig): void {
  if (!cfg.enabled) {
    logger.info("model-router: ready — disabled via config (no overrides will be issued)");
    return;
  }
  logger.info("model-router: ready — stub decider (always T1; WAL active; no model overrides yet)");
  logger.info(`model-router: config ${summarizeConfig(cfg)}`);
}

/**
 * Probe Ollama, ensure the Qdrant collection exists, and (if needed)
 * embed + upload the seed exemplars.
 *
 * Step 5 wires this into gateway_start so by the time Step 6 lands
 * `runSemantic` calls, the exemplar collection is already populated.
 *
 * Fail-soft: any error here is logged and swallowed. The semantic
 * classifier won't run, but the gateway stays up and the heuristic
 * classifier + stub decider continue to work. Step 6's decider must
 * tolerate a "semantic unavailable" condition by falling back to T1.
 */
async function bootstrapSemanticClassifier(
  cfg: ResolvedConfig,
  logger: Logger,
): Promise<void> {
  try {
    const embedder = createEmbedder(cfg.classifier.semantic.embeddings, logger);
    const probe = await embedder.probe();
    if (!probe.ok) {
      logger.warn(
        `model-router: Ollama probe failed (${probe.reason ?? "unknown"}) — semantic classifier disabled for this session`,
      );
      return;
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
  } catch (err) {
    logger.error(
      `model-router: semantic classifier bootstrap failed — falling back to heuristic-only routing: ${String(err)}`,
    );
  }
}
