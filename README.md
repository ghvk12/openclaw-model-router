# openclaw-model-router

[![CI](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml/badge.svg?branch=main)](https://github.com/ghvk12/openclaw-model-router/actions/workflows/plugin-inspector.yml)
![Status](https://img.shields.io/badge/status-pre--alpha-orange)
![Build Stage](https://img.shields.io/badge/build-step%209%2F10-yellow)
![OpenClaw](https://img.shields.io/badge/openclaw-%E2%89%A52026.4.20-blue)
![License](https://img.shields.io/badge/license-MIT-green)

Tiered model router for [OpenClaw](https://github.com/openclaw/openclaw) — picks the cheapest sufficient model per turn via a heuristic + semantic-kNN classifier.

> **Status: CLI audit & exemplars-harvest shipped (Step 9 of 10).** Two new CLI commands give operators visibility into routing quality:
>
> - `npm run audit -- --since=30d` — prints a summary of tier distribution, failover rate, live-routed percentage, classifier breakdown, latency percentiles (p50/p95/p99/mean), and average confidence across all WAL data in the window.
> - `npm run harvest -- --since=30d --min-confidence=0.70 --format=json` — mines high-confidence, non-failover decision rows as seed-exemplar candidates for tuning the semantic kNN classifier.
>
> Verified live against 92 production decisions: 65.2% T2, 34.8% T1; 2.2% failover rate; p50 latency 0.25ms; 32 exemplar candidates harvested at confidence ≥ 0.70. **239 unit tests** across 14 files — `Status: PASS, Breakages: 0` from `plugin-inspector ci`.
>
> **Default tier mapping (cleanly monotonic cost ladder):**
> - **T0** = `deepseek/deepseek-v4-flash` (~$0.10-0.30 / MTok)
> - **T1** = `deepseek/deepseek-v4-pro` (~$1-3 / MTok) — picks up most traffic
> - **T2** = `google/gemini-3.1-pro-preview` ($2 / $12 / MTok)
> - **T3** = `anthropic/claude-opus-4-6` ($5 / $25 / MTok)
>
> See the [GO-LIVE checklist](#go-live-checklist-step-7) below for the exact `openclaw.json` snippets to enable live routing for this default mapping. Operators can override any tier via config without code changes.
>
> **Production setup note for Qdrant:** the semantic classifier needs read+write access to your Qdrant instance. Either set `plugins.entries.model-router.config.classifier.semantic.qdrant.apiKey` in `~/.openclaw/openclaw.json` (same key value as memory-rag's qdrant config), or run Qdrant in a no-auth dev mode. Without this, bootstrap returns `Unauthorized` and the plugin falls back to heuristic-only routing (announced in the boot log).
>
> The **Build Stage** badge above is bumped manually with each step commit; the **CI** badge reflects the real `plugin-inspector ci` outcome on every push to `main`.

## What it does

Routes every agent turn across four tiers based on prompt complexity. Default tier mapping (DESIGN.md §16.1):

| Tier | Default model | Picked when |
|---|---|---|
| **T0** | `deepseek/deepseek-v4-flash` (~$0.10-0.30/MTok) | Trivial turns (greetings, ack, simple lookups) — only when heuristics AND semantic kNN agree with confidence > 0.80 |
| **T1** | `deepseek/deepseek-v4-pro` (~$1-3/MTok) | Default for everything not confidently classified elsewhere; picks up the largest share of traffic |
| **T2** | `google/gemini-3.1-pro-preview` ($2/$12 per MTok) | Multi-step reasoning, code, math, debug — heuristic escalate keywords or semantic vote |
| **T3** | `anthropic/claude-opus-4-6` ($5/$25 per MTok) | Long-context (>200K tokens), multimodal, or T2 failover |

All four are overridable via `plugins.entries.model-router.config.tiers.*` in `openclaw.json`. See [`DESIGN.md`](./DESIGN.md) for the full architecture, SDK contract verification, and rationale.

## Requirements

- OpenClaw >= 2026.4.20
- Node 22.14+ (24 recommended)
- API keys (one per provider you intend to route to):
  - DeepSeek API key for T0 + T1 (the default ladder uses DeepSeek for both)
  - Google AI Studio API key for T2 (Gemini 3.1 Pro Preview)
  - Anthropic API key for T3 (Claude Opus 4.6)
- For semantic classifier: the same Qdrant + Ollama embeddings stack used by [`openclaw-memory-rag`](../openclaw-memory-rag/) — a second collection (`router_exemplars_v1`) is created automatically by the plugin's `gateway_start` bootstrap

## Install (from local checkout)

```bash
cd ./openclaw-model-router
npm install
npm run build
openclaw plugins install .
openclaw plugins enable model-router
```

Then add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "model-router": {
        "enabled": true,
        "config": {
          "liveRouting": false,
          "classifier": {
            "semantic": {
              "qdrant": { "apiKey": "${QDRANT_API_KEY}" }
            }
          }
        }
      }
    }
  }
}
```

Restart the gateway: `openclaw gateway restart`. With `liveRouting: false` (default) you'll see decision rows accumulate in `~/.openclaw/model-router/wal/decisions-YYYY-MM-DD.jsonl` but model selection is unchanged from your existing setup. Confirm by tailing the WAL — if rows are landing, the plugin is observing correctly.

## GO-LIVE checklist (Step 7)

When you're ready to flip from observability-only to actually overriding model selection, do these in order:

### 1. Register the per-tier provider/models in `openclaw.json`

The plugin's tier validation will refuse to register at boot if any tier doesn't resolve. The default mapping needs these entries under `models.providers`:

```json
{
  "models": {
    "providers": {
      "deepseek": {
        "apiKey": "${DEEPSEEK_API_KEY}",
        "models": [
          { "id": "deepseek-v4-flash", "contextWindow": 1000000, "cost": { "input": 0.20, "output": 0.40 } },
          { "id": "deepseek-v4-pro",   "contextWindow": 1000000, "cost": { "input": 1.5,  "output": 6.0  } }
        ]
      },
      "google": {
        "apiKey": "${GOOGLE_AI_API_KEY}",
        "models": [
          { "id": "gemini-3.1-pro-preview", "contextWindow": 1000000, "cost": { "input": 2.0, "output": 12.0 } }
        ]
      },
      "anthropic": {
        "apiKey": "${ANTHROPIC_API_KEY}",
        "models": [
          { "id": "claude-opus-4-6", "contextWindow": 1000000, "cost": { "input": 5.0, "output": 25.0 } }
        ]
      }
    }
  }
}
```

### 2. Enable live routing on the plugin

```json
{
  "plugins": {
    "entries": {
      "model-router": {
        "enabled": true,
        "config": {
          "liveRouting": true,
          "classifier": {
            "semantic": {
              "qdrant": { "apiKey": "${QDRANT_API_KEY}" }
            }
          }
        }
      }
    }
  }
}
```

### 3. Restart the gateway and verify boot logs

```bash
openclaw gateway restart
tail -f ~/.openclaw/logs/gateway.log
```

You should see (in this order):

```
model-router: tier validation OK (T0=deepseek/deepseek-v4-flash, T1=deepseek/deepseek-v4-pro, T2=google/gemini-3.1-pro-preview, T3=anthropic/claude-opus-4-6)
model-router: ready — LIVE ROUTING (modelOverride enabled). Decisions emit { modelOverride, providerOverride } to the gateway and are recorded in the WAL with routedLive=true
model-router: config enabled=true, liveRouting=LIVE, default=T1, T0=deepseek/deepseek-v4-flash, T1=deepseek/deepseek-v4-pro, T2=google/gemini-3.1-pro-preview, T3=anthropic/claude-opus-4-6, classifier=heuristic+semantic(enabled)
```

If you see `refusing to register live routing` instead, the error message embeds three recovery options — pick one and restart.

### 4. Smoke-test live routing

Send a few prompts and verify the response model matches what the WAL says was chosen:

```bash
openclaw agent --prompt "thanks"                          # expect T1 (no_semantic conservative)
openclaw agent --prompt "Refactor this loop into a map"   # expect T2 (heuristic_escalate)

tail -1 ~/.openclaw/model-router/wal/decisions-$(date +%F).jsonl | jq '{tier:.tierChosen, model:.modelChosen, routedLive:.routedLive}'
```

`routedLive: true` confirms the override was actually returned to the gateway.

### Rollback procedure (if something goes sideways)

Pick the most-conservative option that addresses your symptoms:

1. **Quickest** — set `liveRouting: false` in `openclaw.json` and `openclaw gateway restart`. The plugin returns to observability-only mode (Step 6 behavior); decisions still land in the WAL, gateway uses default model selection.
2. **Disable the plugin** — `openclaw plugins disable model-router` then `openclaw gateway restart`. Plugin doesn't register at all; gateway is identical to never having installed it.
3. **Uninstall** — `openclaw plugins uninstall model-router`. Removes the plugin entirely; safe for clean removal.

## Architecture

```
                           ┌────────────────────────────────────────┐
prompt ──────────────────► │ before_model_resolve (priority 100)    │
                           │   1. heuristic classifier              │ ◄─ inlined CJK-aware token estimator
                           │   2. semantic kNN (Qdrant + Ollama)    │ ◄─ reuses memory-rag's Ollama+Qdrant infra
                           │   3. combine + tier decision           │
                           │   4. toModelOverride(decision, cfg)    │ ◄─ Step 7: gates on cfg.liveRouting
                           │   5. write decision to JSONL WAL       │ ◄─ includes routedLive: boolean
                           │   6. return { modelOverride, ... }     │ ◄─ undefined when liveRouting=false
                           └────────────────┬───────────────────────┘
                                            │
                                            ▼
                           ┌────────────────────────────────────────┐
                           │ before_prompt_build                    │ ◄─ memory-rag injects RAG context here
                           │ (handled by memory-rag)                │
                           └────────────────┬───────────────────────┘
                                            │
                              chosen model dispatched ─► (Step 8) circuit-breaker watches model_call_ended
```

Pure-function source units (all unit-tested in isolation):
- `src/router.ts` — `toModelOverride(decision, cfg)`: gates the live override on `cfg.liveRouting`
- `src/router-validate.ts` — `validateTiers(cfg, gatewayConfig)`: checks every tier resolves; `formatValidationError(issues)`: produces the 3-option recovery hint
- `src/classifier/decision.ts` — `decide(input, cfg, deps)`: orchestrates heuristic + semantic + sticky-prior into a `RoutingDecision`
- `src/classifier/heuristics.ts` — `runHeuristics(prompt, cfg)`: pure trivial/escalate detector
- `src/classifier/semantic.ts` — `runSemantic(prompt, cfg, deps)`: weighted kNN vote over Qdrant exemplars
- `src/decision-wal.ts` — daily-rotated, append-only JSONL audit log

## License

MIT
