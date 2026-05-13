import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { adoptLogger, type Logger } from "./logger.js";
import { resolveConfig, summarizeConfig, type ResolvedConfig } from "./config.js";
import { decide } from "./classifier/decision.js";
import { DecisionWAL, type DecisionRow } from "./decision-wal.js";
import { estimateTokens } from "./tokens.js";
import { PriorTierCache } from "./classifier/prior-tier.js";
import { SemanticBootstrap } from "./classifier/semantic-bootstrap.js";
import { toModelOverride } from "./router.js";
import {
  validateTiers,
  formatValidationError,
  type GatewayConfigShape,
} from "./router-validate.js";
import {
  RunAttemptTracker,
  CircuitBreaker,
  substituteTier,
  modelKeyOf,
} from "./failover.js";

/**
 * Step 7 (per DESIGN.md §15, §16): GO-LIVE — the plugin now returns
 * real `{ modelOverride, providerOverride }` from
 * `before_model_resolve` when `cfg.liveRouting === true`, gated by
 * strict tier validation at register-time.
 *
 * Routing-flip safety mechanisms (both new in Step 7):
 *   1. `liveRouting` defaults to `false`. Existing installs continue
 *      in observability-only mode (Step 6 behavior) until the
 *      operator explicitly opts in via openclaw.json. New installs
 *      see WAL rows accumulate without ever changing model selection.
 *   2. Strict tier validation at register-time. Walks every
 *      `cfg.tiers.*` against `api.config.models.providers`. Mismatch
 *      with `liveRouting=true` ⇒ throw with a 3-option recovery hint
 *      (DESIGN.md §16.4); mismatch with `liveRouting=false` ⇒ loud
 *      warning, observability still works.
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

    // Tier validation (Step 7, DESIGN.md §16.4 — soft-warning policy).
    //
    // The validator walks each tier's provider/model against
    // `api.config.models.providers` (the user's openclaw.json model
    // overrides). Two structural blind spots make hard-throwing
    // unworkable in practice:
    //   1. OpenClaw ships a BUNDLED model catalog (e.g. deepseek-v4-flash,
    //      gemini-3-1-pro-preview, claude-opus-4-6 — see
    //      node_modules/openclaw/dist/models-*.js) that is NOT visible
    //      via api.config.models.providers. That field reflects only
    //      user overrides on top of the bundled catalog.
    //   2. When a user does override a provider (e.g. to set custom auth
    //      headers on `deepseek`), the bundled catalog's models still
    //      merge in. So even an explicit `models[]` array doesn't tell
    //      the full story.
    //
    // Net result: the validator has too many false-positive paths to
    // hard-block boot on. We emit warnings (loud, structured) so
    // operators still get an actionable hint when something is clearly
    // wrong, but we never refuse to register. If a tier truly resolves
    // to a non-existent model, the gateway's downstream resolver will
    // surface the per-request error and Step 8's outcome-row capture
    // will record it in the WAL.
    const gatewayConfig = readGatewayConfig(api);
    const tierIssues = validateTiers(cfg, gatewayConfig);
    if (tierIssues.length > 0) {
      const liveStatus = cfg.liveRouting ? "LIVE ROUTING" : "observability-only";
      logger.warn(
        `model-router: ${tierIssues.length} tier${tierIssues.length === 1 ? "" : "s"} flagged by validator (${liveStatus}). Bundled provider catalogs may still satisfy these — see per-line notes. If routing fails at runtime, the gateway will surface per-request errors and Step 8 outcome rows will capture them:`,
      );
      for (const issue of tierIssues) {
        logger.warn(`  • ${issue.tier}: ${issue.reason}`);
      }
      logger.warn(formatValidationError(tierIssues).split("\n").slice(-9).join("\n"));
    } else if (gatewayConfig?.models?.providers) {
      logger.info(
        `model-router: tier validation OK (${tierSummary(cfg)})`,
      );
    } else {
      logger.warn(
        "model-router: tier validation skipped — gateway config didn't expose models.providers (SDK shape skew). Bundled catalogs may still satisfy all tiers",
      );
    }

    const wal = new DecisionWAL(cfg.observability, logger);
    const priorTierCache = new PriorTierCache();
    // Step 8 — reactive failover state (DESIGN.md §6, §16.12).
    //
    // The tracker remembers per-runId attempts so re-invocations of
    // before_model_resolve (which the gateway issues for every failover
    // candidate) can SUBSTITUTE to a different tier instead of re-forcing
    // the broken one. The breaker holds cross-runId failure state for
    // proactive substitution; its outcome-feed is deferred (no stable
    // hook in runtime 2026.4.24 — see DESIGN.md §11) but the breaker is
    // already consulted by `substituteTier` so the proactive path lights
    // up the moment the feed lands.
    const runAttemptTracker = new RunAttemptTracker();
    const circuitBreaker = new CircuitBreaker(cfg.failover);
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
          // We track the ORIGINALLY-decided tier (not any failover
          // substitution we apply below) so sticky-prior bias reflects
          // the router's intent — failover noise stays out of session
          // memory.
          priorTierCache.set(sessionKey, decision.tier);

          // Step 8 — reactive failover & substitution.
          //
          // Look at prior attempts in this same agent run. If THIS is
          // the first invocation of before_model_resolve for runId, the
          // priors list is empty → substituteTier returns the original
          // tier unchanged. If the gateway is re-invoking us for a
          // failover attempt (same runId, second call), the priors
          // contain the original tier → substituteTier walks the
          // ladder and returns a different tier. This breaks the
          // "router re-forces the broken tier on every failover
          // candidate" loop that caused the WhatsApp outage.
          const runId = ctx.runId ?? "";
          const priors = runAttemptTracker.priors(runId);
          const substitution = substituteTier(decision.tier, cfg, priors, circuitBreaker);

          // Determine the tier we'll actually route to.
          //   - Happy path (no substitution): use decision.tier
          //   - Substituted to another tier: use substitution.tier
          //   - All tiers exhausted (substitution.tier === null): return
          //     undefined so the gateway falls back to its own default
          //     chain. We still record the attempt + WAL row.
          let effectiveTier = decision.tier;
          if (substitution.applied && substitution.tier !== null) {
            effectiveTier = substitution.tier;
            logger.warn(
              `model-router: ${substitution.reason} (runId=${runId.slice(0, 8) || "?"})`,
            );
          } else if (substitution.applied && substitution.tier === null) {
            logger.warn(
              `model-router: ${substitution.reason} (runId=${runId.slice(0, 8) || "?"}) — returning undefined`,
            );
          }

          const effectiveTierConfig = cfg.tiers[effectiveTier];
          // Record THIS attempt so the next invocation in the same run
          // (if any — i.e. the gateway hits another failover candidate)
          // can advance further along the ladder.
          if (runId) {
            runAttemptTracker.record(runId, {
              tier: effectiveTier,
              modelKey: modelKeyOf(effectiveTierConfig),
              ts: Date.now(),
            });
          }

          // Step 7 GO-LIVE: convert the decision into the SDK
          // override shape iff cfg.liveRouting=true. Returns undefined
          // when liveRouting=false (observability mode preserved).
          // We hand toModelOverride a decision-shaped object pointing at
          // the EFFECTIVE tier so the override matches what we actually
          // want the gateway to call.
          const override =
            substitution.tier === null
              ? undefined // surrender to gateway default
              : toModelOverride({ ...decision, tier: effectiveTier }, cfg);

          const row: DecisionRow = {
            ts: Date.now(),
            runId,
            promptHash: DecisionWAL.hashPrompt(event.prompt ?? ""),
            promptLen: (event.prompt ?? "").length,
            tokenCountEstimate: estimateTokens(event.prompt ?? ""),
            tierChosen: effectiveTier,
            providerChosen: effectiveTierConfig.provider,
            modelChosen: effectiveTierConfig.model,
            confidence: decision.confidence,
            classifiers: decision.classifiers,
            reason: substitution.applied
              ? `${decision.reason} | ${substitution.reason}`
              : decision.reason,
            classifierLatencyMs: outcome.trace.totalLatencyMs,
            priorTier,
            failoverApplied: substitution.applied,
            routedLive: override !== undefined,
            ...(substitution.applied ? { originalTier: decision.tier } : {}),
          };

          // Fire-and-forget — never await. A slow disk shouldn't add
          // latency to the user request. WAL is best-effort observability,
          // not on the critical path.
          void wal.appendDecision(row);

          // Returns the override (or undefined if liveRouting is off /
          // tier missing). The gateway honors a returned override IFF
          // no higher-priority plugin supersedes us (we registered at
          // priority=100, see HOOK_PRIORITY).
          return override;
        } catch (err) {
          logger.warn(
            `model-router: classifier/WAL failure (request continues unaffected): ${String(err)}`,
          );
          // Fail-soft on any unhandled exception in the hot path: return
          // undefined so the gateway uses its default model. The plugin
          // becomes invisible for this one request rather than breaking it.
          return undefined;
        }
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
  if (cfg.liveRouting) {
    logger.info(
      "model-router: ready — LIVE ROUTING (modelOverride enabled). Decisions emit { modelOverride, providerOverride } to the gateway and are recorded in the WAL with routedLive=true",
    );
  } else {
    logger.info(
      "model-router: ready — observability-only mode. Decisions are computed and recorded in the WAL with routedLive=false; no modelOverride is returned to the gateway. Set plugins.entries.model-router.config.liveRouting = true in openclaw.json to GO LIVE",
    );
  }
  logger.info(
    `model-router: failover armed — substitution ladder enabled, breaker consecutiveFailureThreshold=${cfg.failover.consecutiveFailureThreshold} cooldownMs=${cfg.failover.cooldownMs}`,
  );
  logger.info(`model-router: config ${summarizeConfig(cfg)}`);
}

/**
 * Read-only summary of tier→provider/model used in the boot log on
 * successful tier validation. Mirrors the format from
 * DESIGN.md §16.2's expected boot line.
 */
function tierSummary(cfg: ResolvedConfig): string {
  return (["T0", "T1", "T2", "T3"] as const)
    .map((id) => `${id}=${cfg.tiers[id].provider}/${cfg.tiers[id].model}`)
    .join(", ");
}

/**
 * Defensive read of the gateway's models.providers shape for tier
 * validation. The OpenClawPluginApi type doesn't formally expose this
 * (it's a private surface), but it's been stable across the runtime
 * versions we've tested. We use a structural cast and let
 * `validateTiers` skip-validate if the shape doesn't match (rather
 * than throw). This protects us against SDK shape drift across runtime
 * versions — DESIGN.md §11 documents the runtime/SDK skew we already
 * hit with model_call_ended.
 */
function readGatewayConfig(api: OpenClawPluginApi): GatewayConfigShape | undefined {
  const apiObj = api as unknown as Record<string, unknown>;
  const config = apiObj.config as GatewayConfigShape | undefined;
  if (!config || typeof config !== "object") {
    return undefined;
  }
  return config;
}

