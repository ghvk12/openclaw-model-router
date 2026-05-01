# openclaw-model-router

[![CI](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml/badge.svg?branch=main)](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Build Stage](https://img.shields.io/badge/build-step%205%2F10-yellow)
![OpenClaw](https://img.shields.io/badge/openclaw-%E2%89%A52026.4.20-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Tiered model router for [OpenClaw](https://github.com/openclaw/openclaw) — picks the cheapest sufficient model per turn via a heuristic + semantic-kNN classifier.

> **Status: semantic classifier ready (Step 5 of 10).** The plugin now boots the second classifier tier: a Qdrant-backed semantic kNN over 60 hand-curated exemplars (`src/classifier/exemplars.ts` — 20 each for T0/T1/T2; T3 is intentionally absent because it's reached only via hard escalation rules, not vote). `gateway_start` runs an idempotent bootstrap (`src/classifier/seed-exemplars.ts`): probes Ollama, ensures the `router_exemplars_v1` collection exists with the right dim, and embeds + upserts exemplars only when the collection's point count is below the seed list size. Re-running the bootstrap is a no-op fast path — the count check returns "skipped" without touching Ollama. The semantic classifier itself (`src/classifier/semantic.ts`) implements the DESIGN.md §5 algorithm: embed query → top-K cosine search → weighted vote (similarity × 1.0) → sticky-prior boost (when `priorTier` appears in top-3) → argmax tier + (top-second)/top confidence. The classifier is **not yet wired into routing** — Step 6 plugs the heuristic and semantic signals into `decision.ts`, and Step 7 turns on `modelOverride`. Live smoke verification with Ollama + Qdrant: 60 exemplars seeded in 1.2s, collection state `green`, T3 never voted. Bootstrap is fail-soft — Ollama down or Qdrant unauthorized falls back to the heuristic-only classifier without crashing the gateway. 117 unit tests across 8 files (4 new: exemplars, semantic, seed-exemplars, plus the carryovers).
>
> **Production setup note for Qdrant:** the semantic classifier needs read+write access to your Qdrant instance. Either set `plugins.entries.model-router.config.classifier.semantic.qdrant.apiKey` in `~/.openclaw/openclaw.json` (same key value as memory-rag's qdrant config), or run Qdrant in a no-auth dev mode. Without this, bootstrap returns `Unauthorized` and the plugin falls back to heuristic-only routing (announced in the boot log).
>
> The **Build Stage** badge above is bumped manually with each step commit; the **CI** badge reflects the real `plugin-inspector ci` outcome on every push to `main`.

## What it does (when complete)

Routes every agent turn across four tiers based on prompt complexity:

| Tier | Model (default) | Picked when |
|---|---|---|
| **T0** | Local Ollama (`qwen2.5:7b-instruct`) | Trivial conversational turns (greetings, ack, simple lookups) — only when both heuristics + semantic kNN agree with high confidence |
| **T1** | DeepSeek V4 Flash | Default for everything not confidently classified elsewhere |
| **T2** | DeepSeek V4 Pro | Multi-step reasoning, code, math, debug |
| **T3** | Gemini 3.1 Pro | Long-context (>200K tokens), multimodal, or DeepSeek failover |

See [`DESIGN.md`](./DESIGN.md) for the full architecture, SDK contract verification, and rationale.

## Requirements

- OpenClaw >= 2026.4.20
- Node 22.14+ (24 recommended)
- For T0 (local tier): Ollama with a chat model pulled (`ollama pull qwen2.5:7b-instruct` recommended)
- For semantic classifier (Step 5+): the same Qdrant + Ollama embeddings stack used by [`openclaw-memory-rag`](../openclaw-memory-rag/) — a second collection (`router_exemplars_v1`) is created automatically

## Install (from local checkout)

```bash
cd ./openclaw-model-router
npm install
npm run build
openclaw plugins install .
openclaw plugins enable model-router
```

Then add to `~/.openclaw/openclaw.json`:

```json5
{
  plugins: {
    entries: {
      "model-router": {
        enabled: true,
        config: {
          // Step 1 (current): no other config needed; the plugin no-ops.
          // Step 2 will introduce the full tiers + classifier config block.
        }
      }
    }
  }
}
```

Restart the gateway: `openclaw gateway --port 18790 --verbose`.

## Architecture (target end-state)

```
                           ┌────────────────────────────────────┐
prompt ──────────────────► │ before_model_resolve (priority 100)│
                           │   1. heuristic classifier          │ ◄─ inlined CJK-aware token estimator
                           │   2. semantic kNN (Qdrant)         │ ◄─ reuses memory-rag's Ollama+Qdrant
                           │   3. combine + tier decision       │
                           │   4. write decision to JSONL WAL   │
                           │   5. return { modelOverride, ... } │
                           └────────────────┬───────────────────┘
                                            │
                                            ▼
                           ┌────────────────────────────────────┐
                           │ before_prompt_build                │ ◄─ memory-rag injects RAG context here
                           │ (handled by memory-rag)            │
                           └────────────────┬───────────────────┘
                                            │
                              chosen model dispatched ─► circuit-breaker watches model_call_ended
```

## License

MIT
