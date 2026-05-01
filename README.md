# openclaw-model-router

[![CI](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml/badge.svg?branch=main)](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Build Stage](https://img.shields.io/badge/build-step%206%2F10-yellow)
![OpenClaw](https://img.shields.io/badge/openclaw-%E2%89%A52026.4.20-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Tiered model router for [OpenClaw](https://github.com/openclaw/openclaw) — picks the cheapest sufficient model per turn via a heuristic + semantic-kNN classifier.

> **Status: real decider live in WAL (Step 6 of 10).** The full routing brain is wired up: `src/classifier/decision.ts` orchestrates hard-escalation overrides (long-context → T3, multimodal → T3), the heuristic fast path (`Refactor`/`Debug`/code-fence keywords → T2 @ 0.85), the conservative defaults when semantic isn't available (`heuristic_trivial + no_semantic` → T1 @ 0.6; neutral → T1 @ 0.5), the asymmetric-cost rule (`semantic_T0` alone with neutral heuristic → T1 — never T0 without two agreeing signals), the both-agree-on-trivial path (`heuristic_trivial + semantic_T0 @ >0.80` → T0), the sticky-prior bias (low semantic margin → keep prior turn's tier), and the semantic fail-soft fallback. A bounded `PriorTierCache` (LRU-ish, 1000 entries) tracks the per-session prior. **Live smoke verification (full daemon path):** WAL rows show every code path firing — `Refactor` keyword → T2; code-fence + `Debug` → T2; `What's 2+2?` → T1 via the `semantic_T0 + heuristic_disagreed` asymmetric-cost rule (semantic said T0 with conf 0.315, heuristic neutral, conservative T1 won); Bloom-filter explanation prose → **T2 via `semantic_T2 @ 1.00`** (semantic-driven escalation with no heuristic signal — exactly what the kNN classifier is for). Latency well under the <500ms loose budget: heuristic-only paths <0.15ms, full semantic 60-100ms. Step 6 also fixes a per-process plugin lifecycle gap discovered during smoke testing (`gateway_start` doesn't fire in `openclaw agent` CLI hosts) by introducing `src/classifier/semantic-bootstrap.ts` — a single-flight lazy bootstrap that's eager from `gateway_start` (daemon path) and fire-and-forget from `before_model_resolve` (CLI path); see DESIGN.md §11 for the analysis. **`modelOverride` is still `undefined`** — Step 7 turns the routing live. 150 unit tests across 10 files (3 new: decision, prior-tier, semantic-bootstrap; plus carryovers).
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
