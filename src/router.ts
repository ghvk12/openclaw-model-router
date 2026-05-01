import type { ResolvedConfig } from "./config.js";
import type { RoutingDecision } from "./classifier/types.js";

/**
 * Step 7 (per DESIGN.md §16) — the GO-LIVE mapper.
 *
 * Translates a `RoutingDecision` (from `decide()`) into the SDK's
 * `PluginHookBeforeModelResolveResult` shape. Pure function — no I/O,
 * no state, no logging — so the index.ts hook stays thin and the
 * mapping is fully unit-testable in isolation.
 *
 * Gating logic:
 *   - `cfg.liveRouting === false` → returns `undefined` (observability
 *     mode: decision was computed and WAL'd but no override is emitted).
 *     This is the v0.1 default per the conservative-default rollout
 *     policy (DESIGN.md §10) — operators flip to `true` explicitly via
 *     `openclaw.json` after they've verified their tier mapping resolves.
 *   - `cfg.tiers[decision.tier]` missing → returns `undefined` defensively.
 *     Validation in `router-validate.ts` should catch this at register-time
 *     when liveRouting=true, so this branch is belt-and-braces; reaching
 *     it means the validation was bypassed (e.g. a tier was mutated after
 *     register) or liveRouting was flipped on without a restart. Better
 *     to silently degrade than emit a malformed override.
 *
 * Return shape matches `PluginHookBeforeModelResolveResult` from the
 * verified SDK contract (DESIGN.md §11.1):
 *   - `modelOverride: string`     — e.g. "deepseek-v4-pro"
 *   - `providerOverride: string`  — e.g. "deepseek"
 */

export type ModelOverride = {
  modelOverride: string;
  providerOverride: string;
};

export function toModelOverride(
  decision: RoutingDecision,
  cfg: ResolvedConfig,
): ModelOverride | undefined {
  if (!cfg.liveRouting) {
    return undefined;
  }
  const tier = cfg.tiers[decision.tier];
  if (!tier) {
    return undefined;
  }
  return {
    modelOverride: tier.model,
    providerOverride: tier.provider,
  };
}
