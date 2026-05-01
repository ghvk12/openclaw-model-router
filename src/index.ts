import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { adoptLogger, type Logger } from "./logger.js";
import { resolveConfig, summarizeConfig, type ResolvedConfig } from "./config.js";
import { decide } from "./classifier/decision.js";
import { DecisionWAL, type DecisionRow } from "./decision-wal.js";
import { estimateTokens } from "./tokens.js";
import { PriorTierCache } from "./classifier/prior-tier.js";
import { SemanticBootstrap } from "./classifier/semantic-bootstrap.js";

/**
 * Step 6 (per DESIGN.md §15): observability before behavior change —
 * the plugin now runs the real `decide()` orchestrator on every
 * request and writes structured RoutingDecision rows to the daily
 * JSONL WAL, but `modelOverride` is still `undefined`. Operators
 * can now audit "what the router would have done" before the
 * GO-LIVE flip in Step 7.
 *
 * Per-process lifecycle (DESIGN.md §11):
 *   - Long-lived gateway daemon: `gateway_start` fires once at boot,
 *     awaits `semanticBootstrap.ensureReady()` so first request has
 *     semantic deps available.
 *   - Per-invocation CLI host (`openclaw agent ...` without
 *     `--local`): `gateway_start` does NOT fire — the per-request
 *     `semanticBootstrap.kickoff()` call kicks off bootstrap from
 *     the hot path without blocking; first request runs heuristic-only,
 *     subsequent requests in the same process see semantic kick in.
 *
 * Both the WAL writer and the semantic-bootstrap are fail-soft: a
 * misconfigured `walDir`, an Ollama/Qdrant outage, or any other
 * dependency failure logs once and degrades gracefully — the
 * gateway itself never crashes from a routing failure.
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
    const priorTierCache = new PriorTierCache();
    // Single-flight semantic-classifier bootstrap. Both lifecycles
    // converge here:
    //   - Long-lived gateway daemon: gateway_start awaits ensureReady()
    //     so the very first request already sees semantic available.
    //   - Per-invocation CLI process: gateway_start never fires, but
    //     before_model_resolve calls kickoff() on every request — the
    //     first request runs heuristic-only (semantic still booting),
    //     subsequent requests in the same process see semantic kick in
    //     once the bootstrap settles.
    // Both paths are fail-soft: a failed bootstrap is logged once and
    // the process continues with heuristic-only routing for its lifetime.
    const semanticBootstrap = new SemanticBootstrap(cfg, logger);

    api.on(
      "before_model_resolve",
      async (event, ctx) => {
        if (!cfg.enabled) {
          return undefined;
        }

        // Classify + decide. Wrapped so a bug here can never break the
        // request — the gateway gets `undefined` (no override) on any
        // throw, identical to having the plugin uninstalled.
        try {
          const sessionKey = ctx.sessionKey ?? ctx.sessionId ?? null;
          const priorTier = priorTierCache.get(sessionKey);

          // Fire-and-forget — first request in a process kicks off
          // the semantic bootstrap without paying its latency. From
          // call 2 onward (inside the same long-lived process) the
          // semantic deps are usually ready. Short-lived CLI processes
          // never benefit, but they're not the primary traffic path.
          semanticBootstrap.kickoff();

          const outcome = await decide(
            {
              prompt: event.prompt ?? "",
              attachments: event.attachments,
              priorTier,
            },
            cfg.classifier,
            { semantic: semanticBootstrap.deps() },
          );
          const decision = outcome.decision;

          // Update the prior-tier cache for the NEXT turn of this session.
          // We track the decided tier (not the actually-routed tier) so
          // sticky-prior bias reflects the router's intent rather than
          // any failover substitutions that happen later (Step 8).
          priorTierCache.set(sessionKey, decision.tier);

          const tier = cfg.tiers[decision.tier];
          const row: DecisionRow = {
            ts: Date.now(),
            runId: ctx.runId ?? "",
            promptHash: DecisionWAL.hashPrompt(event.prompt ?? ""),
            promptLen: (event.prompt ?? "").length,
            tokenCountEstimate: estimateTokens(event.prompt ?? ""),
            tierChosen: decision.tier,
            providerChosen: tier.provider,
            modelChosen: tier.model,
            confidence: decision.confidence,
            classifiers: decision.classifiers,
            reason: decision.reason,
            classifierLatencyMs: outcome.trace.totalLatencyMs,
            priorTier,
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

        // Step 6 still no-ops on routing — Step 7 wires the real override.
        // The WAL now shows the REAL decision the router would have made,
        // not the always-T1 stub. This is "shadow mode within
        // observability before behavior change" (DESIGN.md §10).
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

      // Eager bootstrap for the long-lived gateway daemon — block
      // until ready (or definitively failed) so the very first
      // request already has semantic deps available. This is the
      // best UX for the daemon path; per-CLI-invocation processes
      // never reach gateway_start and instead use the lazy kickoff()
      // path inside before_model_resolve.
      if (cfg.classifier.semantic.enabled) {
        await semanticBootstrap.ensureReady();
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
  logger.info(
    "model-router: ready — real decider (heuristic + semantic + sticky-prior); WAL active; no model overrides yet (Step 7 turns on routing)",
  );
  logger.info(`model-router: config ${summarizeConfig(cfg)}`);
}

