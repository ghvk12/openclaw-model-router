import type { Logger } from "../logger.js";
import type { SemanticEmbeddingsConfig } from "../config.js";

/**
 * Thin Ollama embeddings client tailored to the model-router's needs.
 *
 * Why not reuse openclaw-memory-rag/src/ollama-embeddings.ts directly?
 *   - This is a separate plugin (DESIGN.md §2.2 — independence).
 *   - We only need `embedQuery` (single-vector) and `embedBatch` (for
 *     bootstrap). Memory-rag's adapter layer is overkill.
 *   - Keeping it self-contained means model-router can be installed
 *     without memory-rag (mirrors §2.2 promise).
 *
 * Compatible with Ollama 0.1.27+ (uses /api/embed batch endpoint, falls
 * back to /api/embeddings for older daemons). Same posture as
 * memory-rag's client — just narrower surface.
 */

export class RouterEmbeddingError extends Error {
  override readonly cause?: unknown;
  readonly status?: number;

  constructor(message: string, cause?: unknown, status?: number) {
    super(message);
    this.name = "RouterEmbeddingError";
    if (cause !== undefined) {
      this.cause = cause;
    }
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export type RouterEmbedder = {
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  /** Probe Ollama health and confirm the model is pulled. */
  probe(): Promise<{ ok: boolean; reason?: string }>;
  readonly model: string;
  readonly dim: number;
  readonly url: string;
};

/**
 * mxbai-embed-large (and most BERT-derived embedders) cap at 512 tokens.
 * Exemplars and incoming prompts are usually short, but we truncate
 * defensively at 1100 chars to match memory-rag's posture (~275 tokens
 * for ASCII; degrades to ~400 for emoji/CJK-dense input). Truncation is
 * applied only to the text we send to the embedder; the full text stays
 * in the WAL via the prompt hash.
 */
const MAX_EMBED_CHARS = 1100;
const DEFAULT_TIMEOUT_MS = 30_000;

function truncateForEmbedding(text: string): string {
  if (text.length <= MAX_EMBED_CHARS) {
    return text;
  }
  return text.slice(0, MAX_EMBED_CHARS);
}

export function createEmbedder(
  cfg: SemanticEmbeddingsConfig,
  logger: Logger,
  fetchImpl: typeof fetch = fetch,
): RouterEmbedder {
  const baseUrl = cfg.url.replace(/\/$/, "");
  const model = cfg.model;
  const dim = cfg.dim;

  async function postJson<T>(path: string, body: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new RouterEmbeddingError(
          `Ollama ${path} returned ${res.status}: ${text.slice(0, 200)}`,
          undefined,
          res.status,
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof RouterEmbeddingError) {
        throw err;
      }
      throw new RouterEmbeddingError(`Ollama ${path} request failed: ${String(err)}`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function embedBatchViaApi(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }
    const safeTexts = texts.map(truncateForEmbedding);
    try {
      const res = await postJson<{ embeddings: number[][] }>("/api/embed", {
        model,
        input: safeTexts,
      });
      if (!Array.isArray(res?.embeddings) || res.embeddings.length !== texts.length) {
        throw new RouterEmbeddingError(
          `Ollama returned ${res?.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`,
        );
      }
      return res.embeddings;
    } catch (err) {
      // Fall back to legacy single-text endpoint on 404 — supports older
      // Ollama daemons that haven't shipped batch yet. Same fallback
      // strategy as memory-rag's client, kept in sync intentionally.
      if (err instanceof RouterEmbeddingError && err.status === 404) {
        logger.info(
          "model-router: /api/embed not available, falling back to /api/embeddings (one-by-one)",
        );
        return embedBatchViaLegacy(texts);
      }
      throw err;
    }
  }

  async function embedBatchViaLegacy(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) {
      const res = await postJson<{ embedding: number[] }>("/api/embeddings", {
        model,
        prompt: truncateForEmbedding(text),
      });
      if (!Array.isArray(res?.embedding)) {
        throw new RouterEmbeddingError("Ollama /api/embeddings returned no embedding array");
      }
      out.push(res.embedding);
    }
    return out;
  }

  function validateDim(vec: number[]): number[] {
    if (vec.length !== dim) {
      throw new RouterEmbeddingError(
        `Embedding dim mismatch: got ${vec.length}, configured ${dim}. ` +
          `Update classifier.semantic.embeddings.dim or rebuild the exemplar collection.`,
      );
    }
    return vec;
  }

  return {
    model,
    dim,
    url: baseUrl,

    async embedQuery(text: string): Promise<number[]> {
      const [vec] = await embedBatchViaApi([text]);
      if (!vec) {
        throw new RouterEmbeddingError("Ollama returned no embedding for query");
      }
      return validateDim(vec);
    },

    async embedBatch(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) {
        return [];
      }
      const vectors = await embedBatchViaApi(texts);
      return vectors.map(validateDim);
    },

    async probe(): Promise<{ ok: boolean; reason?: string }> {
      try {
        const tagsRes = await fetchImpl(`${baseUrl}/api/tags`, { method: "GET" });
        if (!tagsRes.ok) {
          return { ok: false, reason: `Ollama /api/tags returned ${tagsRes.status}` };
        }
        const data = (await tagsRes.json()) as {
          models?: Array<{ name?: string; model?: string }>;
        };
        const installed = (data.models ?? [])
          .map((m) => m.name ?? m.model ?? "")
          .filter(Boolean);
        const wanted = model.split(":")[0];
        const found = installed.some(
          (name) => name === model || name.split(":")[0] === wanted,
        );
        if (!found) {
          return {
            ok: false,
            reason: `Model "${model}" not pulled. Run: ollama pull ${model}`,
          };
        }
        const probe = await embedBatchViaApi(["ping"]);
        if (probe.length !== 1 || probe[0]!.length !== dim) {
          return {
            ok: false,
            reason: `Probe returned dim=${probe[0]?.length ?? 0}, expected ${dim}.`,
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: `Ollama probe failed: ${String(err)}` };
      }
    },
  };
}
