# openclaw-model-router

[![CI](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml/badge.svg?branch=main)](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Build Stage](https://img.shields.io/badge/build-step%204%2F10-yellow)
![OpenClaw](https://img.shields.io/badge/openclaw-%E2%89%A52026.4.20-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Tiered model router for [OpenClaw](https://github.com/openclaw/openclaw) — picks the cheapest sufficient model per turn via a heuristic + semantic-kNN classifier.

> **Status: observability before behavior change (Step 4 of 10).** The plugin now writes a daily-rotated JSONL Write-Ahead Log to `~/.openclaw/model-router/wal/decisions-YYYY-MM-DD.jsonl` for every `before_model_resolve` invocation. A stub decider (`src/decider-stub.ts`) always returns `T1`, so the WAL captures *what the router would do* without any real routing happening yet. The decision row schema matches `DESIGN.md` §8 exactly: `ts`, `runId`, `promptHash` (sha256 of normalized prompt — never raw text), `promptLen`, `tokenCountEstimate`, `tierChosen`, `providerChosen`, `modelChosen`, `confidence`, `classifiers`, `reason`, `classifierLatencyMs`, `priorTier`, `failoverApplied`. The WAL writer is fail-soft: full disk / bad path / permission errors log once and silently drop subsequent writes. 76 unit tests cover hashing stability, sampling, daily rotation, concurrent-append correctness, fail-soft init, and a privacy-shape contract that pins the `OutcomeRow` field set so future refactors can't accidentally leak conversation content. Routing itself is still a no-op (`before_model_resolve` returns `undefined`) — Step 7 wires the live `modelOverride`. Outcome-row subscription (`model_call_ended`) is deferred to Step 8 due to a runtime/SDK version skew (live gateway 2026.4.24 vs SDK types 2026.4.26) — see DESIGN.md §11.
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
