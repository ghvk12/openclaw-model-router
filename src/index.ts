import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { adoptLogger, type Logger } from "./logger.js";
import { resolveConfig, summarizeConfig, type ResolvedConfig } from "./config.js";

/**
 * Step 2 (per DESIGN.md §15): full config schema is now resolved at register
 * time — but the routing decision itself is still a no-op. The plugin reads
 * its config, validates security gates (assertSecureUrl), logs a one-line
 * summary on `gateway_start`, and continues to return undefined from
 * `before_model_resolve`. Gateway behavior is identical to having the plugin
 * uninstalled.
 *
 * What's new vs Step 1:
 *   - resolveConfig(rawCfg) parses the full four-tier configuration.
 *   - Misconfigurations (invalid tier id, plaintext non-loopback URLs,
 *     missing required fields) throw at register time and unload the plugin
 *     — better than discovering them at first request.
 *   - The gateway_start log now prints the concrete tier mapping so
 *     operators can verify their config block landed correctly.
 *
 * SDK contract (verified against openclaw@2026.4.25 in DESIGN.md §11):
 *   - register(api) MUST be synchronous; throwing here is fine — the loader
 *     unloads the plugin and the gateway keeps running.
 *   - First non-undefined modelOverride wins (firstDefined merge); we
 *     register at priority 100 to claim authoritative routing once Step 7
 *     wires the real decision.
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
      // resolveConfig throws on invalid config (security gate, bad tier id,
      // malformed URL). Log it loudly and re-throw so the loader unloads the
      // plugin — running with a partial/insecure config is worse than running
      // without the plugin at all.
      logger.error(`model-router: invalid config — refusing to register: ${String(err)}`);
      throw err;
    }

    api.on(
      "before_model_resolve",
      (_event, _ctx) => {
        if (!cfg.enabled) {
          return undefined;
        }
        // Step 2 still no-ops: classifier + tier resolution land in steps 3–7.
        // Returning undefined keeps the harness on its default model.
        return undefined;
      },
      { priority: HOOK_PRIORITY },
    );

    api.on("gateway_start", (_event, _ctx) => {
      logRouterReady(logger, cfg);
    });

    api.on("gateway_stop", (_event, _ctx) => {
      logger.info("model-router: gateway_stop received (skeleton; no resources to close yet)");
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
  // Two-line ready summary so the config snapshot stays grep-able even when
  // logs interleave with other plugins. The first line announces readiness;
  // the second prints the concrete tier mapping operators care about.
  logger.info("model-router: ready — skeleton (config validated; no model overrides yet)");
  logger.info(`model-router: config ${summarizeConfig(cfg)}`);
}
