import { createHash } from "node:crypto";
import type { TierId } from "../config.js";

/**
 * Hand-curated seed exemplars for the semantic kNN classifier.
 *
 * Per DESIGN.md §5: 50–100 exemplars, T0/T1/T2 only (T3 is reached only
 * via hard escalation rules — long-context, multimodal, failover —
 * never via semantic vote). v0.1 ships ~60 exemplars (20 per tier) to
 * stay easy to review by hand.
 *
 * Quality of this list directly governs T0 routing accuracy in the
 * "conservative-default" rollout (DESIGN.md §10) — the harder we make it
 * to look like a T0 prompt, the more often we land on T1 (Flash, the
 * safe default). Curate conservatively; expand from the WAL audit log
 * after week 1 of production traffic.
 *
 * `source: "seed"` marks every entry as a manually-curated bootstrap
 * exemplar. Production-harvested exemplars added later via the audit
 * CLI (Step 9) will use `source: "audit"`. Filtering by `source` lets
 * us roll back a bad audit batch without losing the seed set.
 */

export type ExemplarSource = "seed" | "audit";

export type Exemplar = {
  id: string;
  text: string;
  tier: TierId;
  source: ExemplarSource;
};

/**
 * Build a deterministic exemplar id from text + tier. Same input always
 * produces the same id, so re-running the bootstrap upserts the same
 * points (Qdrant overwrites by id) instead of producing duplicates. This
 * is what makes the bootstrap idempotent.
 *
 * Qdrant accepts string ids OR unsigned 64-bit integers. We use UUIDv5-
 * style hex strings (8-4-4-4-12) so the ids are recognizable as
 * deterministic hashes during debugging — Qdrant happily accepts them
 * since they're valid string ids.
 */
export function exemplarId(text: string, tier: TierId): string {
  const hex = createHash("sha256").update(`${tier}\n${text}`, "utf8").digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const T0_SEEDS: readonly string[] = [
  "thanks",
  "thank you",
  "ok got it",
  "ok thanks",
  "cool",
  "nice",
  "perfect",
  "sounds good",
  "hey",
  "hello",
  "good morning",
  "good night",
  "what time is it?",
  "what day is today?",
  "what time is it in IST?",
  "remind me what we said yesterday",
  "what was the last message?",
  "echo this back to me",
  "say hi",
  "lol",
];

const T1_SEEDS: readonly string[] = [
  "summarize this thread",
  "give me the key points from this conversation",
  "draft a reply to Ravi about the demo",
  "draft a polite decline to this meeting request",
  "what's the status of the auth project?",
  "compare these two options for me",
  "explain what OAuth is",
  "what does idempotent mean?",
  "translate this paragraph to Spanish",
  "rewrite this email to be more concise",
  "list the action items from this thread",
  "what are the pros and cons of switching to Postgres?",
  "tell me about today's calendar",
  "find the message where we discussed pricing",
  "convert this list to a markdown table",
  "what's a good way to phrase this?",
  "make this paragraph sound more professional",
  "give me three subject lines for this email",
  "what are some common patterns for handling retries?",
  "outline a quick proposal for X",
];

const T2_SEEDS: readonly string[] = [
  "refactor this Apex method to be bulkified and SOQL-loop free",
  "why is this trigger throwing CPU limit exceeded errors at scale?",
  "design the data model for a multi-tenant inbox with row-level security",
  "walk me through how to migrate from REST polling to webhook-based delivery",
  "implement a TypeScript helper that retries with exponential backoff and jitter",
  "compare the tradeoffs between Kafka, RabbitMQ, and SQS for our use case",
  "prove this algorithm terminates in O(n log n) and explain each step",
  "derive the closed-form solution for this recurrence relation",
  "debug this stack trace step-by-step and explain what's happening at each frame",
  "design a schema migration that's safe to roll back partway through",
  "implement a rate limiter using the token bucket algorithm with burst handling",
  "explain how the Raft consensus algorithm handles a network partition step-by-step",
  "refactor this React component to use the new server-component model",
  "analyze the time and space complexity of this implementation",
  "write a property-based test suite for this function with proper invariants",
  "design the failure-mode handling for a distributed cache with stale reads",
  "trace through this concurrent code and find the race condition",
  "architect a deployment strategy that supports zero-downtime rollback",
  "implement a reconciler loop with proper backpressure and dead-letter handling",
  "explain why this query plan uses a sequential scan instead of the index",
];

function buildExemplars(texts: readonly string[], tier: TierId): Exemplar[] {
  return texts.map((text) => ({
    id: exemplarId(text, tier),
    text,
    tier,
    source: "seed",
  }));
}

/**
 * Full seed exemplar set, frozen so callers can't accidentally mutate
 * the canonical list (which would break id-based idempotency).
 */
export const SEED_EXEMPLARS: readonly Exemplar[] = Object.freeze([
  ...buildExemplars(T0_SEEDS, "T0"),
  ...buildExemplars(T1_SEEDS, "T1"),
  ...buildExemplars(T2_SEEDS, "T2"),
]);

/**
 * Schema version of the exemplar set. Bump when:
 *   - The seed list changes substantively (new categories, removed items)
 *   - The `Exemplar` payload shape changes
 *
 * Emitted as a Qdrant collection-name suffix (router_exemplars_v1) and
 * as a payload field on every uploaded point so a future migration can
 * tell stale rows from current ones without inspecting text.
 */
export const SEED_EXEMPLARS_VERSION = 1 as const;
