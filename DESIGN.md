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
10. CI: `plugin-inspector ci --no-openclaw --runtime --mock-sdk --allow-execute`
    (mirrors memory-rag's `plugin:ci` script).

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
