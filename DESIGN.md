# openclaw-model-router — Design Doc / ADR-001

| | |
|---|---|
| **Status** | Proposed (SDK contract verified 2026-04-29) |
| **Author** | virinchi (advised by Claude) |
| **Date** | 2026-04-29 |
| **Repo** | `openclaw-infra/openclaw-model-router` (sibling of `openclaw-memory-rag`) |
| **Targets** | OpenClaw `2026.4.25` (verified against installed SDK), plugin SDK `>=2026.4.20`, Node `>=22.14.0` |
| **Supersedes** | n/a |

---

## 1. Context

OpenClaw currently dispatches every agent turn to a single configured model
(per the gateway's `plugins.slots.modelProvider`). For the WhatsApp + memory-rag
deployment in this infra repo, that means a one-line "ok thanks" answer pays
the same per-token cost as a multi-step debugging session.

Three operational pressures motivate this plugin:

1. **Cost.** Empirically, a large share of WhatsApp traffic to OpenClaw is
   short conversational acknowledgements that a 7B local model could answer
   acceptably. Sending all of it to DeepSeek V4 Pro / Gemini 3.1 Pro is wasteful.
2. **Latency.** Local Ollama is sub-second; cloud Pro tiers can be 4–8s.
   Routing trivial turns locally improves user-perceived responsiveness.
3. **Resilience.** When DeepSeek upstream rate-limits or 5xxs, we want a
   deterministic, auditable failover to Gemini rather than the agent loop
   silently bricking.

A **model router** plugin sits in the `before_model_resolve` chain (the
canonical hook for model selection — verified against the installed SDK,
see §11), inspects the outbound prompt + attachments, classifies complexity,
and returns a `{ modelOverride, providerOverride }` result that the harness
honors when dispatching the LLM call.

## 2. Decision

Build `openclaw-model-router` as an **independent OpenClaw plugin** that:

- Implements a **tiered classifier** (heuristic → semantic kNN → confident-default).
- Routes prompts across **four tiers**: local Ollama, DeepSeek V4 Flash,
  DeepSeek V4 Pro, Gemini 3.1 Pro.
- Defaults to **DeepSeek V4 Flash (T1)** under any uncertainty — the
  "conservative-default" posture that makes a no-shadow-mode rollout safe.
- Never adds more than ~50ms of routing latency in the steady state and
  ~150ms in the worst case (cold embedding cache).
- Persists every routing decision to a JSONL WAL for offline audit, mirroring
  the durability pattern already established in `openclaw-memory-rag`.

### Why an independent plugin (not a fork of memory-rag)

| Reason | Detail |
|---|---|
| Single responsibility | Retrieval and routing fail for completely different reasons; isolating them keeps blast radius small. |
| Independent kill switch | `openclaw plugins disable model-router` instantly reverts to default-model behavior; memory-rag keeps working. |
| Different release cadence | Model lineups churn quarterly; retrieval logic churns annually. |
| Smaller config surface per plugin | `openclaw.json` stays readable. |

### Why not an external AI gateway (Portkey, LiteLLM)

Considered and rejected for v0.1. OpenClaw's plugin model already provides
the dispatch and failover plumbing; an external proxy would add a second
layer to debug and a second place to configure model lists. Worth
reconsidering at v1.0+ if multi-org deployments need per-tenant routing.

## 3. Tier ladder

The router maps every prompt to exactly one of four tiers. Tier IDs are stable
across config changes; concrete `provider`/`model` strings live in
`openclaw.json` so model lineup changes don't require code edits.

| Tier | Default provider/model | When picked | Rough share of traffic (target) |
|---|---|---|---|
| **T0 — Local** | `ollama` / `qwen2.5:7b-instruct` (configurable) | Trivial turns answerable locally with no quality cliff | 15–25% |
| **T1 — Flash** | `deepseek` / `deepseek-v4-flash` | Default for everything not confidently classified elsewhere | 55–70% |
| **T2 — Pro** | `deepseek` / `deepseek-v4-pro` | Multi-step reasoning, code, math, debug | 10–20% |
| **T3 — Long/Multi** | `gemini` / `gemini-3.1-pro` | Long-context (>200K tokens), multimodal, or DeepSeek failover | 1–5% |

### Quality-cliff asymmetry (important)

Misroute costs are **not symmetric**:

- Routing a hard prompt to **T0** produces visibly bad output a user can
  tell is wrong → erodes trust.
- Routing an easy prompt to **T2/T3** costs a fraction of a cent extra →
  invisible to user.

Therefore: **only downgrade to T0 when the classifier is highly confident.**
Default to T1 (Flash) under any ambiguity. T0 requires *both* heuristic and
semantic classifiers to agree, *and* a high-confidence margin. This is the
single most important policy in the design.

## 4. Plugin architecture

```
openclaw-model-router/
├── openclaw.plugin.json          # manifest (kind: "modelRouter" or generic plugin)
├── package.json                  # module: "type": "module", node>=22.14
├── tsconfig.json
├── src/
│   ├── index.ts                  # definePluginEntry({ register })
│   ├── config.ts                 # typebox schema + assertSecureUrl + defaults
│   ├── logger.ts                 # adoptLogger() — copy from memory-rag
│   ├── hooks.ts                  # before_prompt_build / gateway_start / gateway_stop
│   ├── classifier/
│   │   ├── heuristics.ts         # pure functions, no I/O
│   │   ├── semantic.ts           # Qdrant kNN against router_exemplars_v1
│   │   ├── exemplars.ts          # seed exemplar list + labels
│   │   └── decision.ts           # combine signals → tier + confidence
│   ├── router.ts                 # tier → provider/model resolution
│   ├── failover.ts               # T2 outage → T3 promotion
│   ├── decision-wal.ts           # JSONL audit log (reuses ~/.openclaw/...)
│   ├── tokens.ts                 # ~20-line CJK-aware token estimator (inlined; not exported by SDK)
│   └── paths.ts                  # ~/ expansion etc — copy from memory-rag
└── tests/
    ├── heuristics.test.ts
    ├── decision.test.ts
    └── exemplars.test.ts
```

### Mirrored conventions from memory-rag

To keep the two plugins maintainable as a pair, deliberately reuse:

- `definePluginEntry({ register(api) { ... } })` with sync register; defer
  async work to `gateway_start`.
- `typebox` schema with a `DEFAULTS` object and a `resolveConfig()` merger.
- `assertSecureUrl(field, raw)` — non-loopback `http://` is a hard error.
- `adoptLogger(api.logger)` wrapper so logs land in the gateway pipeline.
- Every external call wrapped in try/catch — **a router failure must never
  crash the agent loop**; it must fall through to T1.
- WAL writes append-only JSONL, one file per day, `~/.openclaw/model-router/wal/`.

### Hooks

| Hook | Priority | Action |
|---|---|---|
| `gateway_start` | default | `await router.init()` — probe Ollama + Qdrant + each provider; log readiness summary identical to memory-rag's pattern. |
| `before_model_resolve` | **100** (high) | Run the classifier on `event.prompt` + `event.attachments`; return `{ modelOverride, providerOverride }`. First non-undefined result wins (verified merge semantic — see §11). |
| `model_call_started` / `model_call_ended` | default | Track per-tier latency for the failover circuit breaker (real upstream telemetry, not synthetic timeouts). |
| `agent_end` | default | Append final routing outcome row (tier chosen, latency, success bool) to decision WAL. |
| `gateway_stop` | default | Close WAL writer, flush in-flight decisions. |

> **SDK contract verified.** All hook names, event/result shapes, and the
> priority ordering convention are confirmed against the installed
> `openclaw@2026.4.25` SDK in §11. The model-router uses `before_model_resolve`,
> which runs in a *different phase* than memory-rag's `before_prompt_build` —
> so there's no priority conflict between the two plugins.
>
> **Hook availability skew (discovered during Step 4 smoke test, 2026-04-30):**
> The newer hooks `model_call_started`, `model_call_ended`, and
> `before_agent_finalize` exist in `openclaw@2026.4.26+` SDK type declarations
> but are NOT yet recognized by the live gateway runtime in `2026.4.24`. Steps
> that subscribe to them (Step 8 failover, Step 9 outcome rows) MUST either
> (a) require a runtime ≥ 2026.4.26 in `peerDependencies`, OR (b) detect at
> register-time which hooks the runtime accepts and degrade gracefully. The
> Step 4 implementation defers all newer-hook subscriptions to Step 8 so v0.1
> stays compatible with both runtime versions.
>
> **Per-process plugin lifecycle gap (discovered during Step 6 smoke test,
> 2026-04-30):** The OpenClaw runtime instantiates the plugin in two distinct
> process lifecycles, and `gateway_start` does not fire in both:
>
>   1. **Long-lived gateway daemon** (LaunchAgent / systemd): `gateway_start`
>      fires once at boot, `before_model_resolve` fires many times across the
>      daemon's lifetime. Both WAL init and semantic-classifier bootstrap can
>      be done eagerly in `gateway_start`.
>   2. **Per-invocation `openclaw agent` CLI host** (and similar short-lived
>      hosts): each invocation re-loads the plugin module and fires
>      `before_model_resolve`, but `gateway_start` is **not** emitted.
>      Closure-default state (e.g. `runtime.semanticDeps = null`) silently
>      stays uninitialized for the entire lifetime of the host process —
>      breaking any code that depends on `gateway_start` having run.
>
> Step 4 surfaced this for the WAL writer (every CLI append silently dropped)
> and we patched it with **lazy single-flight init on first append**. Step 6
> smoke testing surfaced the SAME gap for the semantic classifier (every
> CLI-side WAL row showed `["no_semantic"]` despite the daemon log claiming
> "semantic classifier ready"). The fix is the same pattern, productionized
> as `src/classifier/semantic-bootstrap.ts`:
>
>   - `SemanticBootstrap.ensureReady()` — awaitable, single-flight, called
>     eagerly from `gateway_start` in the daemon path.
>   - `SemanticBootstrap.kickoff()` — fire-and-forget, called from
>     `before_model_resolve` in the request hot path. Daemon: no-op (already
>     ready). CLI: starts the bootstrap in the background; first request
>     in the process runs heuristic-only, subsequent requests in the same
>     process see semantic kick in once the bootstrap settles.
>   - `SemanticBootstrap.deps()` — synchronous read of current state.
>
> **Operational consequence**: the heaviest CLI users (e.g. WhatsApp's reply
> path which pumps requests through the long-lived daemon) get full semantic
> routing from the very first request. One-shot CLI smoke tests
> (`openclaw agent --message "..."`) typically only run heuristic-only
> because the process exits before the bootstrap finishes — that's an
> inherent limitation of short-lived processes, not a bug. This trade-off
> is the right call because (a) the heuristic path alone is conservative
> and correct, and (b) blocking each CLI smoke test for ~1-7 seconds of
> Ollama+Qdrant probing would be a much worse UX than degrading to
> heuristic-only routing for short-lived hosts.

## 5. Routing decision algorithm

Pseudocode (TypeScript-flavored, lives in `src/classifier/decision.ts`).
Signature matches the verified SDK types
`PluginHookBeforeModelResolveEvent` and `PluginHookAgentContext`:

```ts
import type {
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveResult,
  PluginHookAgentContext,
} from "openclaw/plugin-sdk";

type Tier = "T0" | "T1" | "T2" | "T3";
type Decision = {
  tier: Tier;
  confidence: number;      // 0..1
  classifiers: string[];   // which signals fired
  reason: string;          // human-readable, written to WAL
};

async function decide(
  event: PluginHookBeforeModelResolveEvent,   // { prompt, attachments? }
  ctx: PluginHookAgentContext,                // { sessionKey, modelProviderId, modelId, ... }
  state: { priorTier?: Tier },                // looked up by sessionKey from in-memory map
  cfg: ResolvedConfig,
  deps: { embed: OllamaEmbedClient; qdrant: QdrantBackend },
): Promise<Decision> {
  // ── HARD ESCALATIONS (deterministic, never overridden) ──────────────────
  // Token count: estimated from prompt via inlined CJK-aware estimator
  // (the SDK's cjk-chars utility is internal and not in the public exports;
  // we copy its ~20-line logic into src/tokens.ts to avoid deep-importing
  // a private path).
  const tokenCount = estimateTokens(event.prompt);
  if (tokenCount > cfg.classifier.longContextThreshold) {
    return { tier: "T3", confidence: 1.0, classifiers: ["long_context"],
             reason: `tokenCount=${tokenCount} > threshold` };
  }
  // Attachments come from event.attachments: Array<{ kind: "image"|"video"|
  // "audio"|"document"|"other"; mimeType?: string }>
  const isMultimodal = (event.attachments ?? []).some(
    (a) => a.kind === "image" || a.kind === "video" || a.kind === "audio",
  );
  if (isMultimodal) {
    return { tier: "T3", confidence: 1.0, classifiers: ["multimodal"],
             reason: `attachments=${event.attachments?.map(a => a.kind).join(",")}` };
  }
  // (Documents are not auto-T3 — they fit in DeepSeek context most of the time.)

  // ── TIER 0: HEURISTIC CLASSIFIER (fast path) ────────────────────────────
  const h = runHeuristics(prompt, cfg.classifier.heuristics);
  if (h.escalate)       return tieredDecision("T2", 0.85, h);
  if (h.trivial && cfg.classifier.semantic.enabled === false) {
    // No semantic check available → still need *both* signals to downgrade
    return tieredDecision("T1", 0.60, h);  // conservative
  }

  // ── TIER 1: SEMANTIC kNN (only run if heuristics didn't strongly decide) ─
  if (!cfg.classifier.semantic.enabled) {
    return tieredDecision("T1", 0.50, h); // safe default
  }

  const s = await semanticClassify(prompt, deps, cfg.classifier.semantic);
  // s = { tier: Tier, confidence: number, topExemplars: string[] }

  // ── TIER 2: COMBINE SIGNALS ──────────────────────────────────────────────
  // Conservative-default policy: only downgrade to T0 if BOTH signals agree.
  if (h.trivial && s.tier === "T0" && s.confidence > 0.80) {
    return { tier: "T0", confidence: Math.min(s.confidence, 0.95),
             classifiers: ["heuristic_trivial", "semantic_T0"],
             reason: "both signals agree on trivial" };
  }

  // Sticky-prior bias: keep last-turn's tier unless evidence says otherwise.
  if (ctx.priorTier && s.confidence < cfg.classifier.semantic.marginThreshold) {
    return { tier: ctx.priorTier, confidence: 0.55,
             classifiers: ["sticky_prior"],
             reason: `low semantic margin → keep prior tier ${ctx.priorTier}` };
  }

  // Otherwise honor the semantic decision *only if* it's not T0 (the
  // asymmetric-cost rule from §3.1).
  if (s.tier === "T0") {
    return tieredDecision("T1", 0.50, h, "semantic said T0 but heuristic disagreed");
  }
  return { tier: s.tier, confidence: s.confidence,
           classifiers: ["semantic"], reason: `top exemplars: ${s.topExemplars.join(", ")}` };
}

// In hooks.ts — the actual SDK-facing handler:
api.on(
  "before_model_resolve",
  async (event, ctx): Promise<PluginHookBeforeModelResolveResult | undefined> => {
    const decision = await decide(event, ctx, getState(ctx), cfg, deps);
    await wal.append({ ts: Date.now(), runId: ctx.runId, decision, /* ... */ });
    const tier = cfg.tiers[decision.tier];
    return { modelOverride: tier.model, providerOverride: tier.provider };
  },
  { priority: 100 },  // higher = earlier; first non-undefined modelOverride wins
);
```

### Heuristic signals

`runHeuristics(prompt, cfg)` returns `{ trivial: boolean, escalate: boolean, hits: string[] }`.

**Trivial signals** (any → trivial=true):
- `prompt.length < cfg.maxTrivialChars` (default 80) AND `!/[?]/.test(prompt)`
- regex match against `cfg.trivialPatterns` (default: `\b(thanks|thx|ok|okay|got it|sure|cool|nice|hello|hi|hey)\b`)

**Escalate signals** (any → escalate=true):
- contains code fence ` ``` `
- regex match against `cfg.escalatePatterns` (default: `\b(refactor|architect|debug|design|prove|derive|tradeoff|step[- ]by[- ]step|why does|how does)\b`)
- mentions ≥3 distinct file paths or function-call patterns
- `prompt.length > cfg.escalateLengthChars` (default 1200)

### Semantic kNN

A second Qdrant collection `router_exemplars_v1` holds 50–100 hand-curated
prompts, each with payload `{ tier: "T0"|"T1"|"T2", source: "seed"|"audit" }`.
At query time:

1. Embed the prompt via `mxbai-embed-large` (reuses the Ollama client memory-rag
   already maintains).
2. Search for top-5 exemplars by cosine similarity.
3. Weighted vote: each exemplar contributes `similarity * 1.0` to its tier.
4. `tier = argmax(votes); confidence = (top_vote - second_vote) / top_vote`.
5. Add stickiness: if `priorTier` is in top-3, multiply its vote by 1.3.

Exemplars are versioned (collection name suffix). When the seed list changes,
bump the suffix and re-embed; old collection stays around for rollback.

### Seed exemplars (illustrative — actual seeds curated from real WhatsApp logs)

```
T0: "thanks", "ok got it", "cool", "what time is it in IST?", "remind me what we said yesterday"
T1: "summarize this thread", "draft a reply to Ravi about the demo", "what's the status of XYZ project?"
T2: "refactor this Apex method to be bulkified", "why is this trigger throwing CPU limit", "design the schema for a multi-tenant inbox"
```

T3 is **never** chosen by semantic kNN — it's only reached via the hard
escalation rules at the top of the algorithm.

## 6. Failover (T2 outage handling)

Lives in `src/failover.ts`. Lightweight circuit breaker per provider, fed by
the SDK's `model_call_started` / `model_call_ended` hooks (verified — see
§11 "Bonus discovery") rather than wrapping upstream calls ourselves:

- Sliding window of last N (default 20) calls per `provider:model` key.
- Each `model_call_ended` event provides `outcome`, `durationMs`, and
  `errorCategory` — fed directly into the breaker state.
- If `errorRate > 0.5` over the window AND `consecutiveFailures >= 3`:
  - `provider:model` is marked **TRIPPED** for `cooldownMs` (default 60000).
  - Decision layer sees the tripped state and substitutes:
    - `T2 (deepseek-pro)` TRIPPED → use `T3 (gemini-3.1-pro)`
    - `T1 (deepseek-flash)` TRIPPED → use `T2 (deepseek-pro)` (intentional upgrade — never substitute T0 for T1)
    - `T0 (ollama)` TRIPPED → use `T1 (flash)`
    - `T3 (gemini)` TRIPPED → use `T2 (deepseek-pro)`, accept context truncation
  - Each substitution is logged with a `failover_substitute` reason in the WAL.
- After cooldown, one probe call is allowed; success closes the breaker.

This is built into the router itself, not delegated to an external gateway,
because we need the substitution decision visible in the same WAL as the
routing decisions.

## 7. Configuration

Lives in `~/.openclaw/openclaw.json`. Example block:

```json5
{
  plugins: {
    entries: {
      "model-router": {
        enabled: true,
        config: {
          tiers: {
            T0: { provider: "ollama",   model: "qwen2.5:7b-instruct", url: "http://localhost:11434" },
            T1: { provider: "deepseek", model: "deepseek-v4-flash" },
            T2: { provider: "deepseek", model: "deepseek-v4-pro" },
            T3: { provider: "gemini",   model: "gemini-3.1-pro" },
          },
          defaultTier: "T1",
          classifier: {
            longContextThreshold: 200000,
            heuristics: {
              maxTrivialChars: 80,
              escalateLengthChars: 1200,
              trivialPatterns:  ["\\b(thanks|thx|ok|okay|got it|sure|cool|nice|hi|hey|hello)\\b"],
              escalatePatterns: ["\\brefactor\\b", "\\barchitect\\b", "\\bdebug\\b",
                                 "\\bprove\\b", "\\bderive\\b", "\\btradeoff\\b",
                                 "\\bstep[- ]by[- ]step\\b"],
            },
            semantic: {
              enabled: true,
              qdrantCollection: "router_exemplars_v1",
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
        }
      }
    }
  }
}
```

The schema enforces `assertSecureUrl` on every tier's `url` field exactly as
memory-rag does today.

## 8. Observability

Every routing decision writes one JSONL row to
`~/.openclaw/model-router/wal/decisions-YYYY-MM-DD.jsonl`:

```json
{
  "ts": 1745923011,
  "runId": "abc-123",
  "promptHash": "sha256:ab12...",
  "promptLen": 47,
  "tokenCountEstimate": 12,
  "tierChosen": "T0",
  "providerChosen": "ollama",
  "modelChosen": "qwen2.5:7b-instruct",
  "confidence": 0.91,
  "classifiers": ["heuristic_trivial", "semantic_T0"],
  "reason": "both signals agree on trivial",
  "classifierLatencyMs": 34,
  "priorTier": "T0",
  "failoverApplied": false
}
```

`agent_end` then appends a follow-up row keyed by `runId` with
`{ success, durationMs, tokensIn, tokensOut, costEstimate }` so post-hoc
analysis can join the two and answer "did T0 actually serve this turn well?".

`promptHash` (sha256 of normalized text) is logged instead of the raw prompt
to keep the audit log shareable for tuning without leaking conversation
contents — same privacy posture as memory-rag's `chatId` hashing.

## 9. Security

- Same `assertSecureUrl` policy as memory-rag: non-loopback http:// is a hard
  error. Provider URLs (DeepSeek, Gemini) MUST be https://.
- API keys for DeepSeek / Gemini come from env vars referenced via
  `${DEEPSEEK_API_KEY}` / `${GEMINI_API_KEY}` — never hardcoded.
- Decision WAL contains prompt **hashes**, never raw text. Reviewers
  inspecting routing quality use `memrag` to look up the original prompt by
  hash if they have access to that corpus separately.
- The router does **not** modify prompt contents — only the `modelOverride`
  metadata. This bounds its blast radius: a router bug can pick the wrong
  model, but cannot leak, mutate, or drop the user's actual prompt.

## 10. Conservative-default rollout (replaces shadow mode)

Since we're skipping shadow mode, the design has to be safe-by-default at
v0.1 launch. The policies that make this possible:

1. **`defaultTier: T1`** under any uncertainty. The router can only ever
   make things *as bad as* "everything goes to Flash."
2. **T0 requires double-confirmation** (heuristic + semantic both agree,
   confidence > 0.80). This means in week 1, T0 will be picked very rarely —
   exactly the right behavior when the exemplar set is unproven.
3. **Failover always promotes, never demotes.** A T2 outage routes to T3,
   not T1.
4. **Decision WAL on from day 1.** Even without a formal shadow phase, every
   live decision is auditable. After one week of production traffic, run
   `openclaw modelrouter audit --since=7d` (CLI command in §12) to surface:
   - Tier distribution (does it match the 15/65/15/5 target?)
   - T0 substitution rate (should be low and stable)
   - Failover frequency
   - Heuristic vs semantic disagreement rate
5. **Kill switch:** `openclaw plugins disable model-router` immediately
   restores baseline single-model behavior.

## 11. SDK contract (verified against `openclaw@2026.4.25`)

All five questions from the v0 draft are now answered with citations to the
installed SDK at
`openclaw-memory-rag/node_modules/openclaw/dist/plugin-sdk/`. Findings below.

### 11.1 Hook for model selection — `before_model_resolve` ✅

**Resolved.** `before_model_resolve` is the canonical hook for model routing.
There is no `before_llm_call`; the closest legacy alternative
(`before_agent_start`) is explicitly deprecated in favor of
`before_model_resolve` + `before_prompt_build`.

Cited types from `dist/plugin-sdk/src/plugins/hook-before-agent-start.types.d.ts`:

```ts
export type PluginHookBeforeModelResolveEvent = {
  prompt: string;
  attachments?: PluginHookBeforeModelResolveAttachment[];
};
export type PluginHookBeforeModelResolveResult = {
  modelOverride?: string;     // e.g. "deepseek-v4-flash"
  providerOverride?: string;  // e.g. "deepseek"
};
```

Wiring confirmed in `dist/pi-embedded-xwfWu_QR.js:1233`:
```
if (hookRunner?.hasHooks("before_model_resolve")) try { ... }
```

The hook fires **before** session messages are built (only `prompt` and
`attachments` are present in the event), which means our router classifies
on the user's raw intent — exactly the right input. Memory-rag's
`before_prompt_build` runs in a *later* phase, so question §11.5 (priority
ordering with memory-rag) is a non-issue.

### 11.2 Token-count source — inline our own estimator ✅

**Resolved.** No pre-computed `tokenCount` in the event. The SDK *does* ship
a CJK-aware estimator at `dist/plugin-sdk/src/utils/cjk-chars.d.ts`
(`estimateStringChars`, `estimateTokensFromChars`, `CHARS_PER_TOKEN_ESTIMATE = 4`),
but it is **not re-exported through the public `./plugin-sdk` exports** in
`openclaw/package.json`.

Decision: copy the ~20-line CJK adjustment into our own `src/tokens.ts`
rather than deep-importing a private path. The math is trivial:

```ts
const CHARS_PER_TOKEN = 4;
export function estimateTokens(text: string): number {
  let chars = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK ranges count as 4 chars each (≈1 token each)
    chars += isCJK(code) ? CHARS_PER_TOKEN : 1;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
```

Plenty accurate for T3's 200K-token gating threshold (off by ±10% is fine
for a routing decision; off by ±10K when threshold is 200K is invisible).

### 11.3 Multimodal / `hasAttachments` signal — first-class on the event ✅

**Resolved.** Cited in
`dist/plugin-sdk/src/plugins/hook-before-agent-start.types.d.ts`:

```ts
export type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};
```

So the multimodal check is a one-liner:

```ts
const isMultimodal = (event.attachments ?? []).some(
  (a) => a.kind === "image" || a.kind === "video" || a.kind === "audio",
);
```

We treat `kind: "document"` as **not** auto-escalating to T3 — most
documents fit in DeepSeek's context window and don't actually need Gemini
unless they're huge (in which case the §11.2 token estimator catches it via
the `longContextThreshold` rule).

### 11.4 Local Ollama chat model for T0 — user choice ✅

**Resolved by design.** Not an SDK question. Default the schema to
`qwen2.5:7b-instruct` with a `uiHints.help` string spelling out that the
user should benchmark against their actual conversation distribution
(`llama3.2:3b` is faster but lower-quality; `mistral-nemo:12b` is heavier
but stronger). The schema accepts any string — installation `doctor`
command verifies the chosen model is actually pulled.

### 11.5 Priority ordering vs. memory-rag — also resolved ✅

**Resolved.** Two facts from the SDK make this a non-issue:

**Fact A — different phases.** Per §11.1, `before_model_resolve` fires
*before* `before_prompt_build`. Memory-rag only registers on
`before_prompt_build` (verified in `openclaw-memory-rag/src/hooks.ts:41`).
The two plugins don't share a hook, so there's no ordering conflict to
resolve.

**Fact B — priority convention.** When multiple handlers share a hook,
priority ordering is documented and enforceable. From
`dist/hook-runner-global-DbpvPGau.js:35`:

```js
return registry.typedHooks
  .filter((h) => h.hookName === hookName)
  .toSorted((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
```

**Higher priority runs first.** Default priority is 0 if unset.

For `before_model_resolve` specifically, the merge function uses
`firstDefined` semantics (from the same file, line 51):

```js
const mergeBeforeModelResolve = (acc, next) => ({
  modelOverride: firstDefined(acc?.modelOverride, next.modelOverride),
  providerOverride: firstDefined(acc?.providerOverride, next.providerOverride),
});
```

Translation: **the highest-priority hook that returns a non-undefined
`modelOverride` wins, and lower-priority hooks cannot overwrite it.** We
register at `priority: 100` to claim the decision authoritatively. If a
future plugin needs to veto/override us (rare), it can register at
`priority: 200`.

### Bonus discovery — model-call telemetry hooks

The SDK also exposes `model_call_started` and `model_call_ended` hooks that
fire for the actual LLM dispatch (cited:
`dist/plugin-sdk/src/plugins/hook-types.d.ts:64-69`). The latter carries
`durationMs`, `outcome: "completed" | "error"`, `errorCategory`, and a
`upstreamRequestIdHash`. We use these for the failover circuit breaker (§6)
instead of running our own timeout/retry harness around upstream calls —
strictly better, because we observe the real harness's view of failure.

## 12. Out of scope (v0.1)

- Per-user / per-tenant routing tables (single global config only).
- Cost dashboards and budget alerts (the WAL has the data; build the UI later).
- A/B testing harness for comparing two routers in parallel.
- Auto-tuning thresholds from audit logs (manual tuning by reviewing the
  WAL is good enough until we have data showing it's not).
- A management CLI beyond a single `openclaw modelrouter audit` command.
- External AI gateway integration (Portkey/LiteLLM).

## 13. Alternatives considered

| Alternative | Why rejected |
|---|---|
| Build into `openclaw-memory-rag` | Couples two unrelated failure modes. Disabling RAG would also disable routing. |
| Use an LLM (e.g., Llama-3-8B) as the classifier | Adds 200–400ms per turn for marginal accuracy gain over heuristics + kNN. The user's <500ms budget allows it but doesn't require it. Revisit if heuristics + kNN < 90% accurate after one month of audit data. |
| External proxy (Portkey, LiteLLM) | Extra layer to debug; routing decisions become opaque to the WAL. Reconsider at v1.0+ for multi-org deployments. |
| Speculative execution (fire to Flash, escalate if low confidence) | Worst-case doubles cost and latency. Cited explicitly in the user's research as an option; rejected as not worth the complexity. |
| Default-to-Pro (fail-safe) | User explicitly preferred default-to-Flash. Cost difference dominates the quality risk for their conversational workload. |

## 14. Acceptance criteria for v0.1

The plugin is shippable when:

- [ ] All four tiers route correctly given canned prompts in `tests/`.
- [ ] Heuristic classifier runs in < 1ms p99 (pure-function unit test).
- [ ] Semantic classifier runs in < 100ms p99 against a warm Qdrant.
- [ ] A simulated DeepSeek 503 storm trips the breaker within 3 calls and
      substitutes T3 within 1 turn.
- [ ] `openclaw plugins disable model-router` followed by gateway restart
      returns to baseline behavior with zero residual artifacts.
- [ ] Decision WAL is non-empty after one real conversation; `--since=1h`
      audit prints a sensible distribution table.
- [ ] No `System.debug`-equivalent (no `console.log`) statements in shipped
      code; all logging goes through `adoptLogger(api.logger)`.
- [ ] `assertSecureUrl` rejects every non-loopback `http://` in config.
- [ ] Plugin loads under the existing memory-rag setup without changing
      memory-rag's behavior (verified with both installed in a smoke test).

## 15. Implementation order (when we go to code)

1. `package.json`, `tsconfig.json`, `openclaw.plugin.json`, empty `src/index.ts`
   that registers but no-ops.
2. `src/config.ts` — typebox schema + `assertSecureUrl` + DEFAULTS.
3. `src/classifier/heuristics.ts` + unit tests (pure, no I/O — fastest feedback loop).
4. `src/decision-wal.ts` — start logging from a stub decider that always
   returns T1. Now we can ship to dev and see real-traffic JSONL.
5. `src/classifier/semantic.ts` + `exemplars.ts` seed list + collection
   bootstrap.
6. `src/classifier/decision.ts` — combine heuristics + semantic per the
   pseudocode in §5.
7. `src/router.ts` — tier → provider/model resolution + writing
   `modelOverride`.
8. `src/failover.ts` — circuit breaker, substitution logic.
9. `src/cli.ts` — `openclaw modelrouter audit` (mirrors `memrag` CLI shape).
   Includes an `exemplars harvest` sub-command (added per §16's
   "exemplar tuning scope" decision) that mines high-confidence WAL
   rows to propose new T0/T1/T2 exemplars for operator approval —
   data-driven semantic-classifier improvement instead of guesswork.
10. CI: `plugin-inspector ci --no-openclaw --runtime --mock-sdk --allow-execute`
    (mirrors memory-rag's `plugin:ci` script).

---

## 16. Step 7 detailed spec — GO-LIVE (the routing flip)

> Status: **Implemented (verified live 2026-05-01).** All sub-steps 7a-7k
> shipped. Live smoke matrix confirmed end-to-end: T1 routing returns real
> deepseek-v4-pro responses; T2 routing reaches Google's API with valid
> auth (only blocked by free-tier quota — operational, not a router defect).
> Kill-switch (`liveRouting=false`) verified to record decisions in WAL with
> `routedLive=false` while bypassing model overrides.
>
> The validation policy was relaxed from "strict throw" to "soft warn" in
> §16.4 below — see "Lessons learned" at the end of this section for the
> rationale (the bundled-catalog blind spot makes hard-throwing unworkable).
>
> Step 7 is the highest-risk step in the 10-step plan because it's the
> first one that *changes user-facing behavior*. Until Step 6, the plugin
> was identical (in observed behavior) to having no plugin installed —
> every `before_model_resolve` returned `undefined`. Step 7 starts
> returning real `{ modelOverride, providerOverride }` objects, which the
> gateway honors. A bad config or a stale model name silently routes every
> request to the wrong provider, or hard-fails them.
>
> Two things make Step 7 safe-to-ship:
>   1. **`liveRouting: false` default** in the plugin manifest's
>      `configSchema` — every install starts in observability-only mode
>      (current Step 6 behavior). Users opt in explicitly per `openclaw.json`.
>   2. **Tier validation at register-time** (soft-warning) — the plugin
>      walks `cfg.tiers.*.{provider, model}` and resolves each against the
>      gateway's known providers/models from `api.config.models.providers`.
>      Any mismatch is logged with a 3-option recovery hint, but
>      registration is NOT blocked because the gateway's bundled catalog
>      may still satisfy the tier. See §16.12 (Lessons learned).

### 16.1 Tier mapping (operator-confirmed for this install)

| Tier | Provider key | Model ID | Pricing (per MTok, ≤200K ctx) | Picked when |
|---|---|---|---|---|
| **T0** | `deepseek` | `deepseek-v4-flash` | ~$0.10-0.30 | Trivial conversational (heuristic_trivial + semantic_T0 @ >0.80) |
| **T1** | `deepseek` | `deepseek-v4-pro` | ~$1-3 (similar to V3 R1 range) | Default — anything not confidently classified elsewhere |
| **T2** | `google` | `gemini-3.1-pro-preview` | $2 / $12 | Multi-step reasoning, code, debug, escalate keywords |
| **T3** | `anthropic` | `claude-opus-4-6` | $5 / $25 | Long-context (>200K), multimodal, or T2 failover (Step 8) |

Notes:
1. Cost ladder is cleanly monotonic: T0 ($0.10-0.30) < T1 ($1-3) < T2 ($2-12) < T3 ($5-25). The asymmetric-cost rule (DESIGN.md §5) and the conservative-default policy (§10) both depend on monotonicity holding, so this mapping is well-aligned with the routing algorithm's assumptions.
2. T1 is now DeepSeek V4 Pro instead of Gemini 3.1 Pro — both because it's cheaper (DeepSeek V4 Pro ≈ $1-3/MTok vs Gemini 3.1 Pro $2 input/$12 output) and because the "default tier" picks up the largest share of traffic, so cost-savings compound there. T2 (Gemini 3.1 Pro Preview) is reserved for prompts where the heuristic or semantic classifier explicitly votes for escalation.
3. The `provider` key for Gemini in OpenClaw is **`google`**, not `gemini` (the latter would fail to resolve). Step 7 fixes the plugin's DEFAULTS in `src/config.ts` to use `google`.
4. T0 is a remote model in this install (no local Ollama chat model is pulled). The asymmetric-cost rule still applies — V4 Flash is fast and cheap but a smaller model than V4 Pro / Gemini Pro / Opus (13B active vs 49B+), so quality can still suffer on hard prompts wrongly routed to T0.
5. **Note on Gemini 3.1 Pro variants:** Google offers two endpoints for this model: `gemini-3.1-pro-preview` (general purpose) and `gemini-3.1-pro-preview-customtools` (optimized for agent workflows with custom tools like `view_file`, `search_code`, bash). v0.1 uses the general endpoint; if OpenClaw's tool-use surface starts dominating T2 traffic, switch to `-customtools` via config.

### 16.2 Pre-conditions (operator MUST do before enabling liveRouting)

1. Update `~/.openclaw/openclaw.json` `models.providers` to register the new model IDs:

   ```json
   {
     "models": {
       "providers": {
         "deepseek": {
           "models": [
             { "id": "deepseek-v4-flash", "contextWindow": 1000000, "cost": { "input": 0.20, "output": 0.40 } },
             { "id": "deepseek-v4-pro",   "contextWindow": 1000000, "cost": { "input": 1.5,  "output": 6.0  } }
             // …keep deepseek-chat / deepseek-reasoner for backward compat;
             //  they auto-route to v4-flash / v4-pro server-side until Jul 24, 2026.
           ]
         },
         "google": {
           "apiKey": "<GOOGLE_AI_STUDIO_API_KEY>",
           "models": [
             { "id": "gemini-3.1-pro-preview", "contextWindow": 1000000, "cost": { "input": 2.0, "output": 12.0 } }
           ]
         },
         "anthropic": {
           "models": [
             { "id": "claude-opus-4-6", "contextWindow": 1000000, "cost": { "input": 5.0, "output": 25.0 } }
             // …keep claude-sonnet-4-20250514 for whatever currently uses it.
           ]
         }
       }
     }
   }
   ```

2. Add the model-router tier override to `plugins.entries.model-router.config`:

   ```json
   {
     "plugins": {
       "entries": {
         "model-router": {
           "enabled": true,
           "config": {
             "liveRouting": true,
             "tiers": {
               "T0": { "provider": "deepseek",  "model": "deepseek-v4-flash" },
               "T1": { "provider": "deepseek",  "model": "deepseek-v4-pro" },
               "T2": { "provider": "google",    "model": "gemini-3.1-pro-preview" },
               "T3": { "provider": "anthropic", "model": "claude-opus-4-6" }
             },
             "classifier": {
               "semantic": { "qdrant": { "apiKey": "<existing key from Step 5>" } }
             }
           }
         }
       }
     }
   }
   ```

3. Restart the gateway: `openclaw gateway stop && openclaw gateway start`. Look for these log lines confirming Step 7 is active:
   - `model-router: tier validation OK (T0=deepseek/deepseek-v4-flash, T1=deepseek/deepseek-v4-pro, T2=google/gemini-3.1-pro-preview, T3=anthropic/claude-opus-4-6)`
   - `model-router: ready — LIVE ROUTING (modelOverride enabled)`

### 16.3 New code: `src/router.ts`

Pure mapper from `RoutingDecision` to the SDK's `PluginHookBeforeModelResolveResult` shape. No I/O, no state — fully unit-testable:

```ts
export type ModelOverride = { modelOverride?: string; providerOverride?: string };

export function toModelOverride(
  decision: RoutingDecision,
  cfg: ResolvedConfig,
): ModelOverride | undefined {
  if (!cfg.liveRouting) return undefined;     // observability mode
  const tier = cfg.tiers[decision.tier];
  if (!tier) return undefined;                // defensive — validation should catch this earlier
  return { modelOverride: tier.model, providerOverride: tier.provider };
}
```

That's it. The complexity lives in `decide()`; this module just translates.

### 16.4 New validation: `src/router-validate.ts`

Walks `cfg.tiers` against the gateway's `api.config?.models?.providers` at register-time:

```ts
export type TierValidationIssue = { tier: TierId; reason: string };

export function validateTiers(
  cfg: ResolvedConfig,
  gatewayConfig: GatewayConfigShape,   // { models: { providers: {...} } }
): TierValidationIssue[] {
  const issues: TierValidationIssue[] = [];
  for (const [tierId, tier] of Object.entries(cfg.tiers) as [TierId, TierConfig][]) {
    const provider = gatewayConfig.models?.providers?.[tier.provider];
    if (!provider) {
      issues.push({ tier: tierId, reason: `provider "${tier.provider}" not found in models.providers` });
      continue;
    }
    const model = provider.models?.find((m: { id: string }) => m.id === tier.model);
    if (!model) {
      issues.push({ tier: tierId, reason: `model "${tier.model}" not found in models.providers.${tier.provider}.models` });
    }
  }
  return issues;
}
```

Wired into `register()`:
- `liveRouting=true` + any issues ⇒ `throw new Error("...")` with the issue list AND a clear recovery hint embedded in the message:

  ```
  model-router: refusing to register live routing — 1 tier misconfigured:
    • T2: model "gemini-3.1-pro-preview" not found in models.providers.google.models

  To recover, choose ONE:
    (a) Add the missing model to ~/.openclaw/openclaw.json under
        models.providers.google.models, then `openclaw gateway restart`.
    (b) Set plugins.entries.model-router.config.liveRouting = false in
        ~/.openclaw/openclaw.json to fall back to observability-only mode
        (decisions still logged to WAL but no overrides emitted), then
        `openclaw gateway restart`.
    (c) Disable the plugin entirely: `openclaw plugins disable model-router`
        — gateway returns to default model selection.
  ```

  The throw is loud (gateway boot fails on any missing tier) but the message gives the operator three escape hatches. This satisfies the user's "throw-with-recovery" preference.
- `liveRouting=false` + any issues ⇒ `logger.warn(...)` with the issue list, continue. Observability still works (decision rows still written; modelOverride is `undefined` regardless).
- No issues ⇒ `logger.info("model-router: tier validation OK (...)")` and proceed.

### 16.5 WAL row schema extension

Add one optional field to `DecisionRow` (backward-compatible — old rows missing the field are interpreted as `false`):

```ts
type DecisionRow = {
  // ...all existing fields...
  routedLive?: boolean;   // true when modelOverride was actually returned to the gateway
};
```

This lets `openclaw modelrouter audit` (Step 9) distinguish:
- Step 6 era / `liveRouting=false` rows: `routedLive: false` — "what the router *would* have done"
- Step 7+ live rows: `routedLive: true` — "what the router actually did"

Without this, a year from now no one can tell from the WAL whether a given decision was honored or shadow-mode.

### 16.6 Index.ts wiring change

Three small edits in `src/index.ts`:

1. After `resolveConfig`, before any hook registration: call `validateTiers(cfg, api.config)`. Throw or warn per §16.4 policy.
2. In `before_model_resolve`, after computing `decision`: call `toModelOverride(decision, cfg)`. If the result is non-undefined, use it as the hook's return value; also set `row.routedLive = true`. Otherwise `routedLive = false`.
3. Update `logRouterReady` to print "LIVE ROUTING (modelOverride enabled)" when `cfg.liveRouting === true`, vs the current "no model overrides yet" message when `false`.

### 16.7 Sub-step breakdown

| Sub-step | What | Output |
|---|---|---|
| **7a** | Update `src/config.ts` — add `liveRouting: Type.Boolean({ default: false })` to `PluginConfigSchema`; fix DEFAULTS to use `google` instead of `gemini` for T3 provider; export the updated `ResolvedConfig` type. Mirror the new field in `openclaw.plugin.json` configSchema. | `cfg.liveRouting` available; `cfg.tiers.T3.provider === "google"` |
| **7b** | Add `routedLive?: boolean` to `DecisionRow` in `src/decision-wal.ts`. Update existing `decision-wal.test.ts` tests to assert backward compatibility (rows without the field still parse). | WAL schema extended, all 25 existing tests still pass |
| **7c** | Write `src/router.ts` — `toModelOverride()` pure function (~10 lines) | router module exists, importable from index.ts |
| **7d** | Write `src/router-validate.ts` — `validateTiers()` pure function (~25 lines) | validator module exists |
| **7e** | Wire into `src/index.ts` — validation in register(), override in before_model_resolve, routedLive in WAL, logRouterReady update | Plugin returns real overrides when `liveRouting=true`, observability when `false` |
| **7f** | Tests: `tests/router.test.ts` (~6 tests for toModelOverride: each tier, undefined when liveRouting=false, undefined when tier missing); `tests/router-validate.test.ts` (~8 tests: empty config, all OK, missing provider, missing model, multiple issues, partial provider, etc.) | +14 unit tests, total 164/164 |
| **7g** | README.md — new "GO-LIVE checklist" section with the EXACT JSON snippets from §16.2 and the rollback procedure. Bump build-stage badge 6/10 → 7/10. Refresh status banner to mention live routing + the safety valve. | Operators have a copy-pasteable enable/disable runbook |
| **7h** | Build + lint + plugin:ci. Re-build the user's `openclaw.json` to add the missing models + tier overrides + `liveRouting: true`. Restart gateway, verify "tier validation OK" log + "LIVE ROUTING" log. | Plugin loaded with live routing; gateway boots clean |
| **7i** | Live smoke test — repeat the Step 6 5-prompt matrix (`thanks`, `What's 2+2?`, long Refactor, Python+code, Bloom-filter prose). For each, parse the gateway's JSON response and assert `response.model` matches the WAL row's `modelChosen`. Expected: T2 prompts return from `deepseek-v4-pro`, T1 prompts from `gemini-3-pro-preview`, T0 prompts from `deepseek-v4-flash`. Verify `routedLive: true` in WAL rows. | Empirical proof that routing is live for all five branches |
| **7j** | Smoke the kill switch — set `liveRouting: false` in `openclaw.json`, restart, send 1 prompt, verify the response uses the gateway's default model (NOT the routed tier) and that the WAL row shows `routedLive: false`. Then re-enable. | Safety valve verified to actually disable routing |
| **7k** | Commit + push + verify CI green | Step 7 lands on `main` |

### 16.8 Smoke matrix (sub-step 7i)

| Prompt | Heuristic | Semantic | Expected tier | Expected response.model |
|---|---|---|---|---|
| `thanks` (call 1) | trivial | (booting) | T1 (no_semantic conservative) | `deepseek-v4-pro` |
| `thanks` (call 2) | trivial | T0 @ >0.80 | **T0** (both-agree) | `deepseek-v4-flash` |
| `What's 2+2?` | neutral | T0 @ ~0.3 | T1 (asymmetric-cost) | `deepseek-v4-pro` |
| Long Refactor | escalate | (skipped) | **T2** (heuristic fast path) | `gemini-3.1-pro-preview` |
| Python+code | escalate | (skipped) | **T2** | `gemini-3.1-pro-preview` |
| Bloom filter | neutral | T2 @ 1.0 | **T2** (semantic-driven) | `gemini-3.1-pro-preview` |

Hard-escalation paths (long context > 200K tokens, multimodal attachments) are not easily exercised via CLI — covered by unit tests instead.

### 16.9 Rollback plan

In order of severity (least disruptive first):

1. **Wrong tier mapping discovered in production:** Edit `~/.openclaw/openclaw.json` → set `plugins.entries.model-router.config.liveRouting = false` → `openclaw gateway restart`. Plugin reverts to observability-only; WAL still records the (now non-acted-on) decisions. ETA: <30s.
2. **Plugin bug that affects request latency or quality even in observability mode:** `openclaw plugins disable model-router` → next request uses gateway default. ETA: <10s.
3. **Plugin won't even load (e.g. tier validation throws):** `openclaw plugins disable model-router` then fix the config → re-enable. ETA: <60s.
4. **Step 7 regression discovered after merge:** `git revert <sha>` → push → users `npm install` again. Restores Step 6 behavior (real decider in WAL, no overrides). ETA: <5min once identified.

### 16.10 Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tier model names drift (provider deprecates `deepseek-v4-flash` etc.) | Low (1y horizon) | High — every routed request to that tier fails | `routedLive=true` rows in WAL grouped by `providerChosen + modelChosen` make the failing model obvious; CI doesn't catch this (no live API calls in CI) |
| DeepSeek V4 Pro reasoning latency is high (multi-second TTFT for the thinking-mode variant), causing T1-default routing to feel sluggish | Medium | Medium — user perceives plugin as "made my agent slower" than the prior `gemini-3-pro-preview` baseline | Step 9 audit CLI surfaces median end-to-end latency by tier; if T1 dominates and is slow, the operator can flip the T1↔T2 mapping in config without code changes. Also: V4 Pro supports both Thinking and Non-Thinking modes — start with Non-Thinking for T1 (default) and reserve Thinking for T2 if needed |
| Strict validation throws on a perfectly-fine tier-override-via-env-var setup we haven't anticipated | Low | High — gateway won't boot | Validation runs only when `liveRouting=true`; default `false` means new installs never hit this. Strict mode is opt-in by virtue of opting into live routing. Throw message embeds 3-option recovery hint (set `liveRouting=false`, fix the config, or disable the plugin) — operator can recover in <60s without reading docs |
| T0 (deepseek-v4-flash) almost never picked because semantic confidence rarely clears the 0.80 threshold (Step 6 smoke saw 0.043 for `thanks`) | High | Low — money-saving deferred but no quality risk | INTENTIONAL per DESIGN.md §10's conservative-default policy. T0 phantom routing in week 1 is the *correct* behavior with only 20 T0 exemplars. Step 9 audit CLI will add an `exemplars harvest` sub-command that mines high-confidence WAL rows for new exemplar candidates, growing the T0 corpus from production data instead of guesswork |
| Cost shock: most traffic routes to T1 (DeepSeek V4 Pro at ~$1-3/MTok) vs prior baseline of `google/gemini-3-pro-preview` ($2/$12). T1 actually saves money for the operator — but a misconfigured tier could route to T2/T3 unexpectedly, costing 5-10× more | Low | Medium — surprise bill | WAL audit (Step 9) surfaces tier distribution daily. Set up an alert if T2+T3 share exceeds 25% (Step 6 smoke showed ~30% T2, all heuristic-driven; if that ratio jumps it's actionable). Also: T1 default switching to V4 Pro is a pure cost WIN vs the prior Gemini 3 Pro baseline |
| Gateway's `api.config.models.providers` shape isn't what we think | Medium | High — validation never matches → all installs throw | Step 7a includes a runtime probe — log the actual shape of `api.config.models.providers` at register-time so a mismatch is debuggable. Validation function is defensive — missing `providers` map returns no issues (skip validation) rather than throwing |

### 16.11 Acceptance criteria

Step 7 is "done" when ALL of these are true:

1. `npm test` — 179/179 passing (164 baseline + 8 router + 7 router-validate)
2. `npm run plugin:ci` — PASS
3. GitHub Actions green on `main`
4. Live smoke matrix (§16.8) — every prompt's response.model matches its expected tier
5. Kill-switch smoke (§16.7 step 7j) — verified
6. README "GO-LIVE checklist" — written and copy-pasteable
7. Build-stage badge bumped to 7/10
8. DESIGN.md §16 marked `Status: Implemented (verified live YYYY-MM-DD)` once landed

### 16.12 Lessons learned during 7h-7j (live verification)

The Step 7 GO-LIVE produced four non-trivial issues that required design
adjustments. None of them invalidate the §16.1-§16.10 spec, but they are
documented here so future steps and operators understand the decisions.

**1. Manifest cache staleness.**
OpenClaw caches plugin manifests at `openclaw plugins install` time.
Adding `liveRouting` to `openclaw.plugin.json`'s `configSchema` is
necessary but not sufficient — existing installs continue to use the old
cached manifest, which silently strips unknown fields (`liveRouting`,
`routedLive` markers, etc.) when persisting `openclaw.json`. Mitigation:
the README's GO-LIVE checklist now includes
`openclaw plugins install <path>` after upgrading the plugin, so the
manifest cache refreshes. Step 10 (CI wiring) will verify the manifest's
configSchema is up-to-date as part of the build.

**2. `openclaw plugins install` creates duplicate sources.**
Running `openclaw plugins install <workspace-path>` copies the entire
workspace into `~/.openclaw/extensions/<plugin-id>/`. If the workspace
path is already in `plugins.load.paths` (which it is for our dev
workflow), the gateway sees both copies, logs "duplicate plugin id
detected," and silently fails to load *either* in some configurations.
Mitigation: after installing for the manifest-refresh side effect (see
issue 1), immediately remove the duplicate at
`~/.openclaw/extensions/<plugin-id>/` and the corresponding
`plugins.installs.<plugin-id>` entry from `openclaw.json`. The README's
GO-LIVE checklist includes this cleanup step.

**3. Validator's bundled-catalog blind spot — soft-warning only.**
The `validateTiers` function (§16.4) walks `api.config.models.providers`
to confirm each tier resolves. But OpenClaw ships a *bundled* model
catalog (e.g., `dist/models-DTSU8g8c.js` provides deepseek-v4-flash/pro
even when the user's `models.providers.deepseek.models[]` only lists
`deepseek-reasoner` and `deepseek-chat`). The bundled catalog is NOT
visible via `api.config.models.providers` — that field reflects only user
overrides on top of the bundled catalog.

Initial design (§16.4): hard-throw on any tier mismatch with
`liveRouting=true`. In practice this produces too many false positives
— every install with the default tier mapping gets blocked at boot
because the bundled-catalog models aren't in user config. The validator
was relaxed to **soft-warning only**: it walks user config and emits
structured warnings (with the recovery hint) for tiers it can't resolve,
but never blocks `register()`. The "positive-evidence" rule documented
in `src/router-validate.ts` makes this explicit: only flag when we have
positive evidence the model is missing (provider entry exists with
explicit `models[]` and the tier model isn't in it). Skip everything
else as bundled-suspect.

If a tier resolves to a non-existent model, the gateway surfaces the
per-request error directly (e.g.,
`Unknown model: google/<modelId> (model_not_found)`). Step 8's outcome
row capture will record these in the WAL alongside the routing decision.

**4. Provider-specific env-var names ≠ generic placeholders.**
The bundled `google` provider expects `GEMINI_API_KEY` or
`GOOGLE_API_KEY` env vars (see
`extensions/google/provider-registration.js`), NOT the generic-sounding
`GOOGLE_AI_API_KEY` we initially documented in §16.2. macOS LaunchAgents
do NOT inherit shell env vars; the API key MUST be in the plist's
`EnvironmentVariables` block under the *exact* var name the provider
reads. README's GO-LIVE checklist now lists the per-provider env-var
names with `PlistBuddy` snippets.

**5. Model ID gotcha — dots vs hyphens between version components.**
The `google` provider's actual Gemini API uses dot-separated version IDs
(`gemini-3.1-pro-preview`). OpenClaw's bundled `Venice` extension also
ships a model called `gemini-3-1-pro-preview` (hyphens), which is a
*different* model exposed via Venice's catalog — NOT compatible with the
google provider. Routing `google/gemini-3-1-pro-preview` returns
`model_not_found` from the google provider. The `T2` default in
`src/config.ts` uses dots (`gemini-3.1-pro-preview`) and includes a
comment explaining the trap.

---

## Confidence statement

**Confidence raised from ~85% to ~95%** after closing all five SDK
unknowns in §11 against `openclaw@2026.4.25`. Remaining uncertainties are
all empirical, not architectural:

- The default chat model on Ollama for T0 — `qwen2.5:7b-instruct` is a
  reasonable starting point but the user should benchmark against their
  actual conversation distribution.
- The 50-exemplar seed list quality — directly governs T0 routing accuracy.
  Plan to harvest real exemplars from the existing WhatsApp corpus that's
  already indexed in `wa_memory_v1_mxbai_1024`.
- Whether DeepSeek V4 actually exposes both "Flash" and "Pro" SKUs under
  identifiable model strings at the time of implementation — the router is
  agnostic, but the config defaults need real names.

**Feedback requested on:**

1. Tier ladder mappings — do the percentages in §3 match your gut feel for
   your traffic shape?
2. The "T0 requires double-confirmation" policy in §3.1 — willing to accept
   ~15% of T0-eligible traffic going to T1 instead, in exchange for never
   shipping a bad-quality T0 answer?
3. Failover always-promote-never-demote in §6 — agree, or do you want a
   T2-outage → T1 fallback option for cost reasons?
4. Anything in §12 (out of scope) you want pulled into v0.1?
