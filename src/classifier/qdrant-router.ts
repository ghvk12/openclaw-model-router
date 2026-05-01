import { QdrantClient } from "@qdrant/js-client-rest";
import type { Logger } from "../logger.js";
import type { SemanticConfig, TierId } from "../config.js";
import type { ExemplarSource } from "./exemplars.js";

/**
 * Thin Qdrant wrapper for the model-router's exemplar collection.
 *
 * Why not reuse openclaw-memory-rag/src/qdrant-client.ts?
 *   - Different schema: dense-only (no sparse vectors), single named
 *     vector, simpler payload, exemplar-specific fields.
 *   - Different collection: `router_exemplars_v1` vs `wa_memory_v1_*`.
 *   - Memory-rag's client is hybrid-search-tuned (dense + sparse fusion);
 *     this one only needs dense cosine search.
 *
 * Both plugins point at the same Qdrant instance — collection names
 * keep the data spaces disjoint.
 */

export class RouterQdrantError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "RouterQdrantError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * On-the-wire payload for each exemplar point. Stable shape — add
 * fields, never rename. `version` lets a future migration distinguish
 * stale rows from current ones without inspecting `text`.
 */
export type ExemplarPayload = {
  text: string;
  tier: TierId;
  source: ExemplarSource;
  version: number;
};

export type ExemplarUpsert = {
  id: string;
  vector: number[];
  payload: ExemplarPayload;
};

export type ExemplarHit = {
  id: string;
  score: number;
  payload: ExemplarPayload;
};

/**
 * Single dense vector named "default" — keeps the on-the-wire shape
 * minimal and avoids the named-vector overhead memory-rag's collection
 * carries for hybrid search.
 */
const VECTOR_NAME = "default";

export class RouterQdrantClient {
  private readonly client: QdrantClient;
  private readonly collection: string;
  private readonly dim: number;
  private readonly logger: Logger;
  /** Single-flight ensureCollection — concurrent first-time callers
   *  share one in-flight Promise rather than racing two creates. */
  private ensurePromise: Promise<void> | null = null;
  private ensured = false;

  constructor(cfg: SemanticConfig, dim: number, logger: Logger) {
    this.client = new QdrantClient({
      url: cfg.qdrant.url,
      ...(cfg.qdrant.apiKey ? { apiKey: cfg.qdrant.apiKey } : {}),
      checkCompatibility: false,
    });
    this.collection = cfg.qdrant.collection;
    this.dim = dim;
    this.logger = logger;
  }

  /**
   * Idempotent — creates the collection on first call, no-ops on
   * subsequent calls. If the collection exists with a different dim,
   * we throw rather than silently silently writing dim-mismatched
   * vectors (which would surface as nonsense search results).
   */
  async ensureCollection(): Promise<void> {
    if (this.ensured) {
      return;
    }
    if (this.ensurePromise) {
      await this.ensurePromise;
      return;
    }
    this.ensurePromise = this.runEnsure().catch((err) => {
      this.ensurePromise = null;
      throw err;
    });
    await this.ensurePromise;
  }

  private async runEnsure(): Promise<void> {
    let exists = false;
    try {
      const collections = await this.client.getCollections();
      exists = collections.collections.some((c) => c.name === this.collection);
    } catch (err) {
      throw new RouterQdrantError(
        `Failed to list Qdrant collections (is it running at the configured url?): ${String(err)}`,
        err,
      );
    }

    if (exists) {
      const info = await this.client.getCollection(this.collection);
      const vectors = info.config?.params?.vectors as
        | Record<string, { size?: number; distance?: string }>
        | { size?: number; distance?: string }
        | undefined;
      const existingDim =
        (vectors as Record<string, { size?: number }>)?.[VECTOR_NAME]?.size ??
        (vectors as { size?: number })?.size;
      if (existingDim !== undefined && existingDim !== this.dim) {
        throw new RouterQdrantError(
          `Qdrant collection "${this.collection}" exists with dim=${existingDim}, ` +
            `but model-router is configured for dim=${this.dim}. ` +
            `Bump the collection name suffix (router_exemplars_v2, ...) or recreate the collection.`,
        );
      }
      this.logger.info(
        `model-router: Qdrant collection "${this.collection}" already exists (dim=${this.dim})`,
      );
      this.ensured = true;
      return;
    }

    try {
      await this.client.createCollection(this.collection, {
        vectors: {
          [VECTOR_NAME]: {
            size: this.dim,
            distance: "Cosine",
          },
        },
      });
      this.logger.info(
        `model-router: created Qdrant collection "${this.collection}" (dim=${this.dim}, distance=Cosine)`,
      );
      this.ensured = true;
    } catch (err) {
      throw new RouterQdrantError(
        `Failed to create Qdrant collection "${this.collection}": ${String(err)}`,
        err,
      );
    }
  }

  /**
   * Upsert (insert or overwrite by id) a batch of exemplar points.
   * Idempotent because exemplar ids are deterministic hashes of
   * (tier, text). Re-running the bootstrap with the same seed list
   * overwrites the same point ids instead of producing duplicates.
   */
  async upsertExemplars(points: ExemplarUpsert[]): Promise<void> {
    if (points.length === 0) {
      return;
    }
    await this.ensureCollection();
    try {
      await this.client.upsert(this.collection, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: { [VECTOR_NAME]: p.vector },
          payload: p.payload as unknown as Record<string, unknown>,
        })),
      });
    } catch (err) {
      throw new RouterQdrantError(
        `Failed to upsert ${points.length} exemplars to "${this.collection}": ${String(err)}`,
        err,
      );
    }
  }

  /**
   * Top-K cosine-similarity search. Returns hits sorted by descending
   * score (Qdrant guarantee). The semantic classifier weights each hit
   * by `score` — higher score = more similar = stronger vote.
   */
  async search(queryVector: number[], topK: number): Promise<ExemplarHit[]> {
    if (topK <= 0) {
      return [];
    }
    if (queryVector.length !== this.dim) {
      throw new RouterQdrantError(
        `Query vector dim=${queryVector.length}, expected ${this.dim}`,
      );
    }
    await this.ensureCollection();
    try {
      const hits = await this.client.search(this.collection, {
        vector: { name: VECTOR_NAME, vector: queryVector },
        limit: topK,
        with_payload: true,
      });
      return hits.map((h) => ({
        id: String(h.id),
        score: typeof h.score === "number" ? h.score : 0,
        payload: h.payload as unknown as ExemplarPayload,
      }));
    } catch (err) {
      throw new RouterQdrantError(
        `Failed to search "${this.collection}": ${String(err)}`,
        err,
      );
    }
  }

  /**
   * How many points the collection currently holds. Used by the
   * bootstrap to decide whether to re-seed (e.g. after a manual delete).
   */
  async countPoints(): Promise<number> {
    try {
      await this.ensureCollection();
      const res = await this.client.count(this.collection, { exact: true });
      return res.count;
    } catch (err) {
      throw new RouterQdrantError(
        `Failed to count points in "${this.collection}": ${String(err)}`,
        err,
      );
    }
  }
}
