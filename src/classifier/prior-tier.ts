import type { TierId } from "../config.js";

/**
 * Bounded in-memory cache of "the tier we picked last turn" keyed by
 * the OpenClaw `sessionKey` (or `sessionId` as fallback). Used by the
 * decision module's sticky-prior bias to avoid alternating-tier
 * flapping in long conversations.
 *
 * Capacity is intentionally small — a handful of KB regardless of
 * traffic — because:
 *   - Most conversations don't run for 1000+ turns.
 *   - When the cache fills, evicting the oldest entry just means that
 *     conversation loses its sticky bias on the next turn (correctness
 *     unchanged, just no continuity boost).
 *   - The plugin doesn't need persistent state across gateway
 *     restarts — boot-fresh behavior is acceptable.
 *
 * Eviction policy: Map preserves insertion order, so deleting
 * `keys().next().value` is FIFO. Not strictly LRU but close enough for
 * a routing hint.
 */

const DEFAULT_CAPACITY = 1000;

export class PriorTierCache {
  private readonly map = new Map<string, TierId>();
  private readonly capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
  }

  /** Read-side. Returns null when no key OR the session has no recorded
   *  prior turn yet (cold conversations). */
  get(sessionKey: string | null | undefined): TierId | null {
    if (!sessionKey) {
      return null;
    }
    return this.map.get(sessionKey) ?? null;
  }

  /** Write-side. Drops a FIFO entry when at capacity to avoid unbounded
   *  growth in long-lived gateways. */
  set(sessionKey: string | null | undefined, tier: TierId): void {
    if (!sessionKey) {
      return;
    }
    if (!this.map.has(sessionKey) && this.map.size >= this.capacity) {
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
    // Re-insert by deleting first so this key becomes the most-recent in
    // insertion order — turns the FIFO into approximate-LRU at zero cost.
    this.map.delete(sessionKey);
    this.map.set(sessionKey, tier);
  }

  /** Test/CLI helper. */
  size(): number {
    return this.map.size;
  }

  /** Test/CLI helper. */
  clear(): void {
    this.map.clear();
  }
}
