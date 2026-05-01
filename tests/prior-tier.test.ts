import { describe, it, expect } from "vitest";
import { PriorTierCache } from "../src/classifier/prior-tier.js";

/**
 * PriorTierCache tests. Covers the read/write API, capacity-bounded
 * eviction, the LRU touch-on-write behavior, and the null-key guards.
 */

describe("PriorTierCache — read/write basics", () => {
  it("returns null for an unknown key", () => {
    const c = new PriorTierCache();
    expect(c.get("never-set")).toBeNull();
  });

  it("returns the previously-set tier", () => {
    const c = new PriorTierCache();
    c.set("session-a", "T2");
    expect(c.get("session-a")).toBe("T2");
  });

  it("overwrites the value on a second set", () => {
    const c = new PriorTierCache();
    c.set("session-a", "T0");
    c.set("session-a", "T2");
    expect(c.get("session-a")).toBe("T2");
  });

  it("returns null for null/undefined/empty session keys", () => {
    const c = new PriorTierCache();
    c.set("session-a", "T1");
    expect(c.get(null)).toBeNull();
    expect(c.get(undefined)).toBeNull();
    expect(c.get("")).toBeNull();
  });

  it("set is a no-op for null/undefined/empty session keys", () => {
    const c = new PriorTierCache();
    c.set(null, "T1");
    c.set(undefined, "T2");
    c.set("", "T3");
    expect(c.size(), "no-op sets should not grow the cache").toBe(0);
  });
});

describe("PriorTierCache — capacity-bounded eviction", () => {
  it("evicts FIFO when capacity is exceeded", () => {
    const c = new PriorTierCache(3);
    c.set("a", "T0");
    c.set("b", "T1");
    c.set("c", "T2");
    c.set("d", "T3"); // forces eviction of "a"
    expect(c.size()).toBe(3);
    expect(c.get("a"), "first inserted should be evicted").toBeNull();
    expect(c.get("b")).toBe("T1");
    expect(c.get("d")).toBe("T3");
  });

  it("touch-on-write makes a key the most-recent (FIFO becomes approx-LRU)", () => {
    const c = new PriorTierCache(3);
    c.set("a", "T0");
    c.set("b", "T1");
    c.set("c", "T2");
    c.set("a", "T3"); // touch — moves "a" to the end of insertion order
    c.set("d", "T0"); // forces eviction; "b" should go (oldest now)
    expect(c.get("a"), "touched key should survive").toBe("T3");
    expect(c.get("b"), "next-oldest should be evicted").toBeNull();
    expect(c.get("c")).toBe("T2");
    expect(c.get("d")).toBe("T0");
  });

  it("default capacity is 1000", () => {
    const c = new PriorTierCache();
    for (let i = 0; i < 1000; i++) {
      c.set(`s${i}`, "T1");
    }
    expect(c.size()).toBe(1000);
    c.set("overflow", "T2");
    expect(c.size(), "size should remain at capacity after overflow").toBe(1000);
    expect(c.get("s0"), "first inserted should evict on overflow").toBeNull();
    expect(c.get("overflow")).toBe("T2");
  });
});

describe("PriorTierCache — clear", () => {
  it("clear() empties the cache", () => {
    const c = new PriorTierCache();
    c.set("a", "T0");
    c.set("b", "T1");
    expect(c.size()).toBe(2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get("a")).toBeNull();
  });
});
