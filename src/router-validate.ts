import type { ResolvedConfig, TierConfig, TierId } from "./config.js";

/**
 * Step 7 tier-validation (per DESIGN.md §16.4).
 *
 * Checks that every tier's `provider/model` combination resolves to
 * something the gateway actually knows about. Run at plugin
 * `register()` time before the gateway accepts requests, so a
 * misconfiguration is caught at boot rather than per-request.
 *
 * Why we need this:
 *   - Step 7 starts emitting `{ modelOverride, providerOverride }`
 *     to the gateway. If a tier points at a non-existent provider
 *     or model, the gateway's model resolver fails on every routed
 *     request to that tier.
 *   - Catching at register-time gives the operator a clear, immediate
 *     boot-log error with a recovery hint instead of a trickle of
 *     per-request errors after deployment.
 *
 * Pure function — no I/O. Tests mock `gatewayConfig`.
 *
 * Defensive design (POSITIVE-EVIDENCE rule):
 *   - The validator only emits a `TierValidationIssue` when it has
 *     POSITIVE evidence the model is missing. The gateway carries a
 *     bundled model catalog (e.g. `dist/models-DTSU8g8c.js` ships
 *     deepseek-v4-flash/pro, gemini-3-1-pro-preview, claude-opus-4-6
 *     etc.) which is NOT visible in `api.config.models.providers` —
 *     that field reflects only the user's openclaw.json additions.
 *   - Therefore: if a tier's provider isn't in user config, treat
 *     it as "provider may be bundled, can't disprove" and SKIP the
 *     tier rather than fail. The gateway will surface the real error
 *     per-request if the provider truly doesn't exist.
 *   - If the provider IS in user config but the model isn't in its
 *     `models[]` array, ALSO skip — the user may have added the
 *     provider for auth/baseUrl overrides while letting the bundled
 *     catalog supply the model definitions.
 *   - We only flag if the provider entry has an explicit `models[]`
 *     array and the tier's model isn't in it AND the array contains
 *     other models (suggesting an exhaustive override — likely a
 *     typo).
 */

/** Minimal shape of gateway config we depend on. Defined defensively
 *  so unexpected SDK changes (extra fields, deeper nesting) don't
 *  break us — we only read what we need. */
export type GatewayConfigShape = {
  models?: {
    providers?: Record<string, { models?: Array<{ id: string }> }>;
  };
};

export type TierValidationIssue = {
  tier: TierId;
  reason: string;
};

const TIER_IDS = ["T0", "T1", "T2", "T3"] as const satisfies readonly TierId[];

export function validateTiers(
  cfg: ResolvedConfig,
  gatewayConfig: GatewayConfigShape | undefined | null,
): TierValidationIssue[] {
  // Defensive: if the SDK doesn't expose api.config in a recognizable
  // shape, skip validation rather than crash. Operators get a single
  // boot warning (logged at the call-site) and live routing can still
  // be opted into manually — they just lose the safety net.
  const providers = gatewayConfig?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }

  const issues: TierValidationIssue[] = [];
  for (const tierId of TIER_IDS) {
    const tier: TierConfig = cfg.tiers[tierId];
    const providerEntry = providers[tier.provider];
    // POSITIVE-EVIDENCE rule (see header docstring):
    //   - Provider not in user config? Could be a bundled provider
    //     (e.g. OpenClaw ships `deepseek`, `google`, `anthropic` with
    //     their own model catalogs). Can't disprove existence — skip.
    //   - Provider in user config but no `models` array? User likely
    //     overrode auth/baseUrl while letting bundled catalog supply
    //     the model list — skip.
    if (!providerEntry) {
      continue;
    }
    const models = providerEntry.models;
    if (!Array.isArray(models) || models.length === 0) {
      continue;
    }
    const found = models.some((m) => m && typeof m.id === "string" && m.id === tier.model);
    if (!found) {
      // User explicitly listed models for this provider, and our model
      // ID isn't among them. This is the only branch where we have
      // POSITIVE evidence of a misconfiguration. Even here it could
      // be a false positive (the bundled catalog merges with user
      // entries) — but it's enough signal to surface to the operator.
      issues.push({
        tier: tierId,
        reason: `model "${tier.model}" not found in models.providers.${tier.provider}.models (known: ${formatKnownModels(models)}). NOTE: bundled provider catalogs may still supply this model — if you're confident the model exists, add it to the user config or set liveRouting=false to bypass`,
      });
    }
  }
  return issues;
}

/**
 * Build the operator-facing error message used by `index.ts` when
 * `liveRouting=true` and `validateTiers()` returns issues. The hint
 * embeds three escape-hatch options (DESIGN.md §16.4) so the operator
 * can recover in <60 seconds without consulting docs.
 *
 * Returned string is multi-line — gateway boot-log writers are
 * expected to print it literally.
 */
export function formatValidationError(issues: readonly TierValidationIssue[]): string {
  const header = `model-router: refusing to register live routing — ${issues.length} tier${issues.length === 1 ? "" : "s"} misconfigured:`;
  const bullets = issues.map((i) => `  • ${i.tier}: ${i.reason}`).join("\n");
  const recovery = [
    "",
    "To recover, choose ONE:",
    "  (a) Add the missing provider(s)/model(s) to ~/.openclaw/openclaw.json",
    "      under models.providers.<provider>.models, then `openclaw gateway restart`.",
    "  (b) Set plugins.entries.model-router.config.liveRouting = false in",
    "      ~/.openclaw/openclaw.json to fall back to observability-only mode",
    "      (decisions still logged to WAL but no overrides emitted), then",
    "      `openclaw gateway restart`.",
    "  (c) Disable the plugin entirely: `openclaw plugins disable model-router`",
    "      — gateway returns to default model selection.",
  ].join("\n");
  return `${header}\n${bullets}\n${recovery}`;
}

function formatKnownProviders(providers: Record<string, unknown>): string {
  const keys = Object.keys(providers);
  if (keys.length === 0) {
    return "(none)";
  }
  return keys.join(", ");
}

function formatKnownModels(models: ReadonlyArray<{ id?: unknown }>): string {
  const ids = models
    .map((m) => (m && typeof m.id === "string" ? m.id : null))
    .filter((id): id is string => id !== null);
  if (ids.length === 0) {
    return "(none)";
  }
  // Cap to first 5 to keep the error message readable; full list is in config.
  return ids.length <= 5 ? ids.join(", ") : `${ids.slice(0, 5).join(", ")}, …${ids.length - 5} more`;
}
