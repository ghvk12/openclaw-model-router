import { describe, expect, it, vi } from "vitest";
import { SemanticBootstrap } from "../src/classifier/semantic-bootstrap.js";
import { resolveConfig, type ResolvedConfig } from "../src/config.js";
import type { Logger } from "../src/logger.js";
import type { SemanticDeps } from "../src/classifier/semantic.js";

/**
 * Tests for the lazy single-flight semantic-classifier bootstrap.
 *
 * Coverage targets:
 *   - Lifecycle states: uninitialized → in-flight → ready / failed / disabled
 *   - Single-flight invariant under concurrent callers
 *   - kickoff() never blocks the caller and never throws
 *   - Permanent failure is sticky (no retry storm)
 *   - Disabled config bypasses bootstrap entirely
 *
 * Production code never instantiates the bootstrap function inline —
 * we inject a stub via the constructor so these tests don't touch
 * Ollama or Qdrant.
 */

function silentLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
}

function configWith(overrides?: { semanticEnabled?: boolean }): ResolvedConfig {
  return resolveConfig({
    classifier: {
      semantic: {
        enabled: overrides?.semanticEnabled ?? true,
      },
    },
  });
}

function fakeDeps(): SemanticDeps {
  return {
    embedder: { embedQuery: vi.fn(), embedBatch: vi.fn(), probe: vi.fn() } as unknown as SemanticDeps["embedder"],
    qdrant: {} as unknown as SemanticDeps["qdrant"],
  };
}

describe("SemanticBootstrap", () => {
  describe("disabled config", () => {
    it("starts in disabled state when semantic.enabled=false", () => {
      const cfg = configWith({ semanticEnabled: false });
      const impl = vi.fn();
      const sb = new SemanticBootstrap(cfg, silentLogger(), impl);

      expect(sb.attempted()).toBe(true);
      expect(sb.deps()).toBeNull();
      expect(impl).not.toHaveBeenCalled();
    });

    it("ensureReady() returns null without calling bootstrap when disabled", async () => {
      const impl = vi.fn();
      const sb = new SemanticBootstrap(configWith({ semanticEnabled: false }), silentLogger(), impl);

      const result = await sb.ensureReady();

      expect(result).toBeNull();
      expect(impl).not.toHaveBeenCalled();
    });

    it("kickoff() is a no-op when disabled", () => {
      const impl = vi.fn();
      const sb = new SemanticBootstrap(configWith({ semanticEnabled: false }), silentLogger(), impl);

      sb.kickoff();

      expect(impl).not.toHaveBeenCalled();
    });
  });

  describe("happy path (enabled, bootstrap succeeds)", () => {
    it("starts in uninitialized state", () => {
      const sb = new SemanticBootstrap(configWith(), silentLogger(), vi.fn());
      expect(sb.attempted()).toBe(false);
      expect(sb.deps()).toBeNull();
    });

    it("ensureReady() runs bootstrap and stores deps for subsequent reads", async () => {
      const deps = fakeDeps();
      const impl = vi.fn().mockResolvedValue(deps);
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      const result = await sb.ensureReady();

      expect(result).toBe(deps);
      expect(sb.deps()).toBe(deps);
      expect(sb.attempted()).toBe(true);
      expect(impl).toHaveBeenCalledTimes(1);
    });

    it("ensureReady() is idempotent — second call returns cached deps without re-bootstrapping", async () => {
      const deps = fakeDeps();
      const impl = vi.fn().mockResolvedValue(deps);
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      await sb.ensureReady();
      const result = await sb.ensureReady();

      expect(result).toBe(deps);
      expect(impl).toHaveBeenCalledTimes(1);
    });

    it("single-flight: concurrent ensureReady() callers share one bootstrap call", async () => {
      const deps = fakeDeps();
      let resolveBootstrap: (deps: SemanticDeps) => void = () => {};
      const inFlight = new Promise<SemanticDeps>((res) => {
        resolveBootstrap = res;
      });
      const impl = vi.fn().mockReturnValue(inFlight);
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      const p1 = sb.ensureReady();
      const p2 = sb.ensureReady();
      const p3 = sb.ensureReady();

      expect(impl).toHaveBeenCalledTimes(1);

      resolveBootstrap(deps);
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(r1).toBe(deps);
      expect(r2).toBe(deps);
      expect(r3).toBe(deps);
      expect(impl).toHaveBeenCalledTimes(1);
    });
  });

  describe("kickoff() on the request hot path", () => {
    it("returns synchronously and starts bootstrap in the background", async () => {
      const deps = fakeDeps();
      const impl = vi.fn().mockResolvedValue(deps);
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      sb.kickoff();

      expect(sb.attempted()).toBe(true);
      expect(sb.deps()).toBeNull();

      await new Promise((r) => setTimeout(r, 0));
      expect(sb.deps()).toBe(deps);
    });

    it("subsequent kickoff() calls don't re-trigger bootstrap", () => {
      const impl = vi.fn().mockResolvedValue(fakeDeps());
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      sb.kickoff();
      sb.kickoff();
      sb.kickoff();

      expect(impl).toHaveBeenCalledTimes(1);
    });

    it("kickoff() when bootstrap rejects does NOT produce an unhandled rejection", async () => {
      const impl = vi.fn().mockRejectedValue(new Error("boom"));
      const logger = silentLogger();
      const sb = new SemanticBootstrap(configWith(), logger, impl);

      sb.kickoff();
      await new Promise((r) => setTimeout(r, 5));

      expect(sb.deps()).toBeNull();
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("semantic bootstrap threw"),
      );
    });
  });

  describe("failure modes", () => {
    it("bootstrap returning null transitions to failed (not in-flight)", async () => {
      const impl = vi.fn().mockResolvedValue(null);
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      const result = await sb.ensureReady();

      expect(result).toBeNull();
      expect(sb.deps()).toBeNull();
      expect(sb.attempted()).toBe(true);
    });

    it("permanent failure: subsequent ensureReady() calls don't retry", async () => {
      const impl = vi.fn().mockResolvedValue(null);
      const sb = new SemanticBootstrap(configWith(), silentLogger(), impl);

      await sb.ensureReady();
      await sb.ensureReady();
      await sb.ensureReady();

      expect(impl).toHaveBeenCalledTimes(1);
    });

    it("bootstrap throwing is caught, logged, and stickily marks failed", async () => {
      const impl = vi.fn().mockRejectedValue(new Error("ollama down"));
      const logger = silentLogger();
      const sb = new SemanticBootstrap(configWith(), logger, impl);

      const result = await sb.ensureReady();
      expect(result).toBeNull();
      expect(sb.deps()).toBeNull();

      await sb.ensureReady();
      expect(impl).toHaveBeenCalledTimes(1);

      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("ollama down"),
      );
    });
  });
});
