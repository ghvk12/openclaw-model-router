import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { adoptLogger, type Logger } from "./logger.js";

/**
 * Step 1 (per DESIGN.md §15): plugin loads, registers a no-op
 * `before_model_resolve` handler, and logs gateway lifecycle. Returning
 * `undefined` from the handler means the harness keeps its default model
 * — gateway behavior is identical to having the plugin uninstalled.
 *
 * This is the safe-by-construction skeleton. Steps 2–7 layer config,
 * classifiers, and the WAL on top of this without ever changing the
 * sync `register(api)` contract.
 *
 * SDK contract (verified against openclaw@2026.4.25 in DESIGN.md §11):
 *   - `register(api)` MUST be synchronous; returning a Promise unloads
 *     the plugin with `Error: plugin register must be synchronous`.
 *   - `before_model_resolve` runs *before* `before_prompt_build`, so the
 *     router sees the user's raw intent, and memory-rag's recall happens
 *     after the model is chosen — no priority conflict between the two.
 *   - First non-undefined `modelOverride` wins (firstDefined merge), and
 *     handlers are sorted highest-priority-first. We register at 100.
 *
 * Hook event/result type imports are deliberately omitted: the SDK does not
 * re-export `PluginHookBeforeModelResolveEvent` / `Result` through the
 * public `./plugin-sdk/plugin-entry` surface (only the inbound-claim hook
 * types leak out). Instead we rely on `OpenClawPluginApi.on()`'s generic
 * `<K extends PluginHookName>` overload to infer the handler signature from
 * the hook name string — same loose-but-typesafe pattern openclaw-memory-rag
 * uses. If the SDK starts re-exporting these we can tighten the annotations
 * later without touching the runtime contract.
 */

type RouterConfig = {
  enabled?: boolean;
};

const HOOK_PRIORITY = 100;

export default definePluginEntry({
  id: "model-router",
  name: "Model Router",
  description:
    "Tiered model router for OpenClaw — picks the cheapest sufficient model per turn.",
  register(api: OpenClawPluginApi) {
    const apiObj = api as unknown as Record<string, unknown>;
    const rawCfg =
      (api.pluginConfig as RouterConfig | undefined) ??
      ((apiObj.config as Record<string, unknown> | undefined)?.modelRouter as
        | RouterConfig
        | undefined) ??
      {};
    const enabled = rawCfg.enabled !== false;
    const logger = adoptLogger(api.logger as Parameters<typeof adoptLogger>[0]);

    api.on(
      "before_model_resolve",
      (_event, _ctx) => {
        if (!enabled) {
          return undefined;
        }
        // Step 1 stub: classifier + tier resolution land in steps 3–7.
        // Returning undefined means the harness keeps its default model.
        return undefined;
      },
      { priority: HOOK_PRIORITY },
    );

    api.on("gateway_start", (_event, _ctx) => {
      logRouterReady(logger, enabled);
    });

    api.on("gateway_stop", (_event, _ctx) => {
      logger.info("model-router: gateway_stop received (skeleton; no resources to close yet)");
    });

    logger.info(
      `model-router: registered before_model_resolve@priority=${HOOK_PRIORITY} (enabled=${enabled})`,
    );
  },
});

function logRouterReady(logger: Logger, enabled: boolean): void {
  const summary = enabled
    ? "ready — skeleton (always returns undefined; no model overrides yet)"
    : "ready — disabled via config (no overrides will be issued)";
  logger.info(`model-router: ${summary}`);
}
