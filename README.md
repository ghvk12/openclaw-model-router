# openclaw-model-router

Tiered model router for [OpenClaw](https://github.com/openclaw/openclaw) — picks the cheapest sufficient model per turn via a heuristic + semantic-kNN classifier.

> **Status: scaffolded (Step 1 of 10).** The plugin loads, registers a `before_model_resolve` hook at priority 100, and currently returns `undefined` for every request — gateway behavior is identical to having the plugin uninstalled. Routing logic is added incrementally per [`DESIGN.md`](./DESIGN.md) §15 implementation order.

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
