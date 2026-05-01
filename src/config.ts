import { Type, type Static } from "typebox";

/**
 * Tier identifiers. Stable across config changes — concrete provider/model
 * strings live in `tiers.{T0,T1,T2,T3}` so DeepSeek/Gemini SKU churn doesn't
 * touch decision logic.
 *
 *   T0 = Local Ollama       — trivial conversational turns
 *   T1 = DeepSeek V4 Flash  — DEFAULT for unclassified prompts
 *   T2 = DeepSeek V4 Pro    — multi-step reasoning, code, math
 *   T3 = Gemini 3.1 Pro     — long-context (>200K tokens), multimodal, failover
 */
export const TierIdSchema = Type.Union(
  [Type.Literal("T0"), Type.Literal("T1"), Type.Literal("T2"), Type.Literal("T3")],
  { default: "T1" },
);
export type TierId = Static<typeof TierIdSchema>;

/**
 * Per-tier provider/model coordinates. `url` is only used for tiers backed by
 * a self-hosted endpoint (currently T0/Ollama) — cloud providers (T1/T2/T3)
 * authenticate via OpenClaw's provider plugins (env vars / Named Credentials)
 * and don't need a URL here.
 */
export const TierConfigSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  url: Type.Optional(Type.String({ minLength: 1 })),
});
export type TierConfig = Static<typeof TierConfigSchema>;

export const TiersConfigSchema = Type.Object({
  T0: TierConfigSchema,
  T1: TierConfigSchema,
  T2: TierConfigSchema,
  T3: TierConfigSchema,
});
export type TiersConfig = Static<typeof TiersConfigSchema>;

/**
 * Tier-0 heuristic classifier. Fast (sub-1ms), pure-function, no I/O.
 *
 *   - `trivialPatterns` mark a prompt as a candidate for T0 downgrade.
 *   - `escalatePatterns` mark a prompt as a candidate for T2 escalation.
 *   - `escalateLengthChars` is a fallback signal: very long prompts often
 *     need reasoning capacity even without keyword hits.
 */
export const HeuristicsConfigSchema = Type.Object({
  maxTrivialChars: Type.Number({ default: 80, minimum: 1, maximum: 4000 }),
  escalateLengthChars: Type.Number({ default: 1200, minimum: 1, maximum: 100000 }),
  trivialPatterns: Type.Array(Type.String({ minLength: 1 })),
  escalatePatterns: Type.Array(Type.String({ minLength: 1 })),
});
export type HeuristicsConfig = Static<typeof HeuristicsConfigSchema>;

/**
 * Tier-1 semantic classifier. Embeds the prompt via Ollama, ANN-searches a
 * Qdrant collection of hand-curated exemplars, weighted-votes the top-K to a
 * tier label.
 *
 * Reuses the same Ollama + Qdrant stack as openclaw-memory-rag. Point both
 * plugins at the same instances (separate collections — `qdrant.collection`
 * defaults to `router_exemplars_v1`, never collides with memory-rag's
 * `wa_memory_v1_*`).
 */
export const SemanticQdrantConfigSchema = Type.Object({
  url: Type.String({ default: "http://localhost:6333" }),
  apiKey: Type.Optional(Type.String()),
  collection: Type.String({ default: "router_exemplars_v1" }),
});
export type SemanticQdrantConfig = Static<typeof SemanticQdrantConfigSchema>;

export const SemanticEmbeddingsConfigSchema = Type.Object({
  url: Type.String({ default: "http://localhost:11434" }),
  model: Type.String({ default: "mxbai-embed-large" }),
  dim: Type.Number({ default: 1024, minimum: 1, maximum: 8192 }),
});
export type SemanticEmbeddingsConfig = Static<typeof SemanticEmbeddingsConfigSchema>;

export const SemanticConfigSchema = Type.Object({
  enabled: Type.Boolean({ default: true }),
  qdrant: SemanticQdrantConfigSchema,
  embeddings: SemanticEmbeddingsConfigSchema,
  topK: Type.Number({ default: 5, minimum: 1, maximum: 50 }),
  marginThreshold: Type.Number({ default: 0.05, minimum: 0, maximum: 1 }),
  stickyPriorBoost: Type.Number({ default: 1.3, minimum: 1, maximum: 10 }),
});
export type SemanticConfig = Static<typeof SemanticConfigSchema>;

export const ClassifierConfigSchema = Type.Object({
  longContextThreshold: Type.Number({ default: 200000, minimum: 1000, maximum: 10000000 }),
  heuristics: HeuristicsConfigSchema,
  semantic: SemanticConfigSchema,
});
export type ClassifierConfig = Static<typeof ClassifierConfigSchema>;

/**
 * Per-provider circuit breaker. `windowSize` is the lookback for error-rate
 * computation; `cooldownMs` is how long a tripped breaker stays open before
 * a single probe call is allowed.
 *
 * Always-promote-never-demote substitution policy lives in `src/failover.ts`
 * (Step 8) — this config block only governs detection thresholds.
 */
export const FailoverConfigSchema = Type.Object({
  windowSize: Type.Number({ default: 20, minimum: 1, maximum: 1000 }),
  errorRateThreshold: Type.Number({ default: 0.5, minimum: 0, maximum: 1 }),
  consecutiveFailureThreshold: Type.Number({ default: 3, minimum: 1, maximum: 100 }),
  cooldownMs: Type.Number({ default: 60000, minimum: 0, maximum: 3600000 }),
});
export type FailoverConfig = Static<typeof FailoverConfigSchema>;

/**
 * JSONL audit log of every routing decision. Mirrors the durability pattern
 * from openclaw-memory-rag's WAL — append-only, one file per day, hash of
 * prompt instead of raw text for privacy.
 */
export const ObservabilityConfigSchema = Type.Object({
  walDir: Type.String({ default: "~/.openclaw/model-router/wal" }),
  logDecisions: Type.Boolean({ default: true }),
  sampleRate: Type.Number({ default: 1.0, minimum: 0, maximum: 1 }),
});
export type ObservabilityConfig = Static<typeof ObservabilityConfigSchema>;

export const PluginConfigSchema = Type.Object({
  enabled: Type.Optional(Type.Boolean({ default: true })),
  /**
   * SAFETY VALVE for Step 7 GO-LIVE. When `false` (default), the plugin
   * runs in observability-only mode — it computes the routing decision
   * and writes it to the WAL, but `before_model_resolve` returns
   * `undefined` so the gateway picks the model normally. When `true`,
   * the plugin returns `{ modelOverride, providerOverride }` and the
   * gateway honors it.
   *
   * Default `false` is the conservative-default rollout policy
   * (DESIGN.md §10) made operational: every install starts in shadow
   * mode and operators opt in explicitly via openclaw.json.
   *
   * Pairs with strict tier validation: when liveRouting=true, the
   * plugin refuses to register if any tier's provider/model isn't
   * resolvable in the gateway's models.providers config.
   */
  liveRouting: Type.Optional(Type.Boolean({ default: false })),
  tiers: Type.Optional(TiersConfigSchema),
  defaultTier: Type.Optional(TierIdSchema),
  classifier: Type.Optional(ClassifierConfigSchema),
  failover: Type.Optional(FailoverConfigSchema),
  observability: Type.Optional(ObservabilityConfigSchema),
});
export type PluginConfig = Static<typeof PluginConfigSchema>;

export type ResolvedConfig = {
  enabled: boolean;
  liveRouting: boolean;
  tiers: TiersConfig;
  defaultTier: TierId;
  classifier: ClassifierConfig;
  failover: FailoverConfig;
  observability: ObservabilityConfig;
};

/**
 * Sensible default trivial-pattern set. Conservative on purpose — these are
 * candidates for downgrade to T0, but the classifier still requires both
 * heuristic + semantic agreement before actually downgrading (DESIGN.md §5).
 */
const DEFAULT_TRIVIAL_PATTERNS: readonly string[] = [
  "\\b(thanks|thx|ok|okay|got it|sure|cool|nice|hi|hey|hello|bye|lol|haha)\\b",
];

/**
 * Sensible default escalation pattern set. These are *terminal* — heuristic
 * escalations win over the semantic vote (DESIGN.md §5) because we'd rather
 * over-spend on Pro than under-serve a debugging request.
 *
 * The literal `\`\`\`` (code-fence) regex catches paste-in code blocks
 * regardless of language.
 */
const DEFAULT_ESCALATE_PATTERNS: readonly string[] = [
  "\\brefactor\\b",
  "\\barchitect\\b",
  "\\bdebug\\b",
  "\\bprove\\b",
  "\\bderive\\b",
  "\\btradeoff\\b",
  "\\bstep[- ]by[- ]step\\b",
  "```",
];

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  /**
   * Default `false` per DESIGN.md §16's conservative rollout: new
   * installs run in observability mode. Operators flip to true in
   * openclaw.json after they've added the matching providers/models.
   */
  liveRouting: false,
  /**
   * Defaults align with DESIGN.md §16.1 — cleanly monotonic cost ladder.
   * Provider key for Gemini is `google` (not `gemini`) to match
   * OpenClaw's bundled provider id; the `gemini` key would fail tier
   * validation when liveRouting=true.
   *
   * T0 default points to deepseek-v4-flash (remote, ~$0.10-0.30/MTok)
   * rather than a local Ollama chat model — avoids the operator
   * needing to `ollama pull` a chat model just to install the plugin.
   * Operators can override to a local model via openclaw.json.
   */
  tiers: {
    T0: { provider: "deepseek", model: "deepseek-v4-flash" },
    T1: { provider: "deepseek", model: "deepseek-v4-pro" },
    // The bundled `google` provider uses dot-separated version IDs
    // (e.g. `gemini-3.1-pro-preview`) — that's what Google's actual
    // Gemini API expects and what the provider's onboard.js declares
    // as `GOOGLE_GEMINI_DEFAULT_MODEL`. The hyphenated form
    // `gemini-3-1-pro-preview` is a different model in OpenClaw's
    // bundled Venice extension catalog, NOT a google provider model —
    // routing `google/gemini-3-1-pro-preview` returns
    // `model_not_found` from the google provider.
    T2: { provider: "google", model: "gemini-3.1-pro-preview" },
    T3: { provider: "anthropic", model: "claude-opus-4-6" },
  },
  defaultTier: "T1",
  classifier: {
    longContextThreshold: 200000,
    heuristics: {
      maxTrivialChars: 80,
      escalateLengthChars: 1200,
      trivialPatterns: [...DEFAULT_TRIVIAL_PATTERNS],
      escalatePatterns: [...DEFAULT_ESCALATE_PATTERNS],
    },
    semantic: {
      enabled: true,
      qdrant: { url: "http://localhost:6333", collection: "router_exemplars_v1" },
      embeddings: { url: "http://localhost:11434", model: "mxbai-embed-large", dim: 1024 },
      topK: 5,
      marginThreshold: 0.05,
      stickyPriorBoost: 1.3,
    },
  },
  failover: {
    windowSize: 20,
    errorRateThreshold: 0.5,
    consecutiveFailureThreshold: 3,
    cooldownMs: 60000,
  },
  observability: {
    walDir: "~/.openclaw/model-router/wal",
    logDecisions: true,
    sampleRate: 1.0,
  },
};

/**
 * Reject `http://` URLs that don't point at loopback. Mirrors the security
 * posture of openclaw-memory-rag's identically-named function: vector
 * payloads contain raw prompt text, and `qdrant.apiKey` is a credential —
 * neither belongs in plaintext on a non-loopback link.
 *
 * Loopback hosts allowed: localhost, 127.0.0.1, ::1, ipv6 loopback wrap,
 * and `*.localhost` per RFC 6761.
 */
export function assertSecureUrl(field: string, raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`model-router: ${field} is not a valid URL: ${raw}`);
  }
  if (parsed.protocol === "https:") {
    return;
  }
  if (parsed.protocol !== "http:") {
    throw new Error(
      `model-router: ${field} must use http:// or https:// (got ${parsed.protocol})`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost");
  if (!loopback) {
    throw new Error(
      `model-router: ${field} uses plaintext http:// to a non-loopback host (${host}). ` +
        `Use https:// to protect prompt payloads and apiKey in transit.`,
    );
  }
}

/**
 * Validate a tier id string. Used by `resolveConfig` to fail loud on a
 * misconfigured `defaultTier` rather than silently picking T1.
 */
function assertTierId(field: string, raw: unknown): TierId {
  if (raw === "T0" || raw === "T1" || raw === "T2" || raw === "T3") {
    return raw;
  }
  throw new Error(
    `model-router: ${field} must be one of T0|T1|T2|T3, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Merge user-supplied plugin config with defaults. Throws on schema-incompatible
 * inputs (invalid tier id, malformed URL, plaintext non-loopback host) but
 * tolerates any missing optional sections by filling in defaults — including
 * tier-0 (Local Ollama URL must be present and pass the loopback check).
 *
 * The merge is *per-section shallow* (matching memory-rag's pattern) rather
 * than recursive deep-merge, because nested arrays (e.g. `trivialPatterns`)
 * should be *replaced wholesale* when the user provides them, not concatenated.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const partial = (raw && typeof raw === "object"
    ? (raw as Partial<PluginConfig>)
    : {}) as Partial<PluginConfig>;

  const resolved: ResolvedConfig = {
    enabled: partial.enabled ?? DEFAULTS.enabled,
    liveRouting: partial.liveRouting ?? DEFAULTS.liveRouting,
    tiers: mergeTiers(partial.tiers),
    defaultTier:
      partial.defaultTier !== undefined
        ? assertTierId("defaultTier", partial.defaultTier)
        : DEFAULTS.defaultTier,
    classifier: mergeClassifier(partial.classifier),
    failover: { ...DEFAULTS.failover, ...(partial.failover ?? {}) },
    observability: { ...DEFAULTS.observability, ...(partial.observability ?? {}) },
  };

  // Security gates — fail before the gateway tries to handle a request.
  assertSecureUrl(
    "classifier.semantic.qdrant.url",
    resolved.classifier.semantic.qdrant.url,
  );
  assertSecureUrl(
    "classifier.semantic.embeddings.url",
    resolved.classifier.semantic.embeddings.url,
  );
  if (resolved.tiers.T0.url !== undefined) {
    assertSecureUrl("tiers.T0.url", resolved.tiers.T0.url);
  }

  return resolved;
}

function mergeTiers(partial: Partial<TiersConfig> | undefined): TiersConfig {
  return {
    T0: { ...DEFAULTS.tiers.T0, ...(partial?.T0 ?? {}) },
    T1: { ...DEFAULTS.tiers.T1, ...(partial?.T1 ?? {}) },
    T2: { ...DEFAULTS.tiers.T2, ...(partial?.T2 ?? {}) },
    T3: { ...DEFAULTS.tiers.T3, ...(partial?.T3 ?? {}) },
  };
}

function mergeClassifier(
  partial: Partial<ClassifierConfig> | undefined,
): ClassifierConfig {
  const base = DEFAULTS.classifier;
  return {
    longContextThreshold: partial?.longContextThreshold ?? base.longContextThreshold,
    heuristics: { ...base.heuristics, ...(partial?.heuristics ?? {}) },
    semantic: mergeSemantic(partial?.semantic),
  };
}

function mergeSemantic(partial: Partial<SemanticConfig> | undefined): SemanticConfig {
  const base = DEFAULTS.classifier.semantic;
  return {
    enabled: partial?.enabled ?? base.enabled,
    qdrant: { ...base.qdrant, ...(partial?.qdrant ?? {}) },
    embeddings: { ...base.embeddings, ...(partial?.embeddings ?? {}) },
    topK: partial?.topK ?? base.topK,
    marginThreshold: partial?.marginThreshold ?? base.marginThreshold,
    stickyPriorBoost: partial?.stickyPriorBoost ?? base.stickyPriorBoost,
  };
}

/**
 * One-line summary of the resolved config for the gateway_start log.
 * Operator-friendly — surfaces the concrete `provider/model` strings the
 * router will route to, plus the master enable/disable knob.
 */
export function summarizeConfig(cfg: ResolvedConfig): string {
  const tiers = (["T0", "T1", "T2", "T3"] as const)
    .map((id) => `${id}=${cfg.tiers[id].provider}/${cfg.tiers[id].model}`)
    .join(", ");
  const semantic = cfg.classifier.semantic.enabled ? "enabled" : "disabled";
  const liveRouting = cfg.liveRouting ? "LIVE" : "observability-only";
  return (
    `enabled=${cfg.enabled}, liveRouting=${liveRouting}, default=${cfg.defaultTier}, ` +
    `${tiers}, classifier=heuristic+semantic(${semantic})`
  );
}
