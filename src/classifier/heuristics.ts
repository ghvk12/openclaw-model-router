import type { HeuristicsConfig } from "../config.js";
import type { HeuristicReason, HeuristicSignal } from "./types.js";

/**
 * Tier-0 (heuristic) prompt classifier.
 *
 * Pure function — no I/O, no globals, no allocations beyond the result.
 * Designed to run in well under 1ms even on multi-KB prompts; the tightest
 * loop is the regex sweep, capped at ~10 patterns by the schema.
 *
 * Decision contract (DESIGN.md §5 "Tier-0 Heuristics"):
 *
 *   trivial = true   IFF
 *     (a) prompt.length < cfg.maxTrivialChars AND prompt has no '?', OR
 *     (b) any cfg.trivialPatterns regex hits the prompt
 *
 *   escalate = true  IFF
 *     (a) prompt contains a triple-backtick code fence, OR
 *     (b) any cfg.escalatePatterns regex hits the prompt, OR
 *     (c) prompt.length > cfg.escalateLengthChars, OR
 *     (d) at least 3 distinct file-path-like / function-call-like tokens
 *         appear in the prompt (combined; "code density" signal)
 *
 * Both flags can be true simultaneously — decision.ts (Step 6) resolves
 * the tie by precedence (escalate wins). The signal is a pure description
 * of *what fired*; routing policy lives elsewhere.
 *
 * False positives are tolerated: the semantic classifier (Step 5) and the
 * double-confirmation rule for T0 downgrades (DESIGN.md §3) act as the
 * second filter. Heuristics' job is to be *fast* and *suggestive*, not
 * authoritative.
 */
export function runHeuristics(
  prompt: string,
  cfg: HeuristicsConfig,
): HeuristicSignal {
  const reasons: HeuristicReason[] = [];
  const promptChars = prompt.length;

  let trivial = false;
  let escalate = false;

  // ── Trivial signal (a): short and not asking a question ──────────────
  // The "no '?'" guard avoids treating "what?" or "really?" as trivial —
  // those are short prompts that likely want a real answer.
  if (promptChars > 0 && promptChars < cfg.maxTrivialChars && !prompt.includes("?")) {
    trivial = true;
    reasons.push({ kind: "trivial_short_no_question", promptChars });
  }

  // ── Trivial signal (b): keyword pattern hit ──────────────────────────
  const trivialHit = firstRegexHit(prompt, cfg.trivialPatterns);
  if (trivialHit !== undefined) {
    trivial = true;
    reasons.push({
      kind: "trivial_pattern_match",
      pattern: trivialHit.pattern,
      matched: truncateMatched(trivialHit.matched),
    });
  }

  // ── Escalate signal (a): code fence ──────────────────────────────────
  // Plain string check — no regex needed, tolerates triple-backticks
  // followed by a language tag (```ts, ```python, etc).
  if (prompt.includes("```")) {
    escalate = true;
    reasons.push({ kind: "escalate_code_fence" });
  }

  // ── Escalate signal (b): keyword pattern hit ─────────────────────────
  const escalateHit = firstRegexHit(prompt, cfg.escalatePatterns);
  if (escalateHit !== undefined) {
    escalate = true;
    reasons.push({
      kind: "escalate_pattern_match",
      pattern: escalateHit.pattern,
      matched: truncateMatched(escalateHit.matched),
    });
  }

  // ── Escalate signal (c): long prompt ─────────────────────────────────
  // Even without keyword hits, a multi-KB prompt almost always benefits
  // from reasoning capacity (and the cost delta from T1→T2 is small
  // compared to the cost of being wrong on a long-context request).
  if (promptChars > cfg.escalateLengthChars) {
    escalate = true;
    reasons.push({ kind: "escalate_long_prompt", promptChars });
  }

  // ── Escalate signal (d): code density ────────────────────────────────
  // Counts file-path-like AND function-call-like tokens; a combined ≥3
  // is a strong signal that the prompt is about code (refactoring,
  // debugging) even when no keyword fires.
  const pathHits = countMatches(prompt, FILE_PATH_RE);
  const callHits = countMatches(prompt, FUNCTION_CALL_RE);
  if (pathHits + callHits >= 3) {
    escalate = true;
    reasons.push({ kind: "escalate_code_density", pathHits, callHits });
  }

  return { trivial, escalate, reasons, promptChars };
}

/**
 * File-path-like token detector. Conservative — requires both a `/` and
 * a recognizable file extension, so URLs (https://example.com) and
 * sentences with slashes ("either/or") don't trip it.
 *
 * Examples that match: `src/foo.ts`, `./bar/baz.json`, `tests/main.test.ts:42`
 * Examples that don't:  `https://example.com`, `either/or`, `tcp/ip`
 */
const FILE_PATH_RE =
  /\b(?:\.{0,2}\/)?[\w.-]+\/[\w./-]+\.[a-zA-Z]{1,8}\b(?::\d+)?/g;

/**
 * Function-call-like token detector. Requires identifier (≥3 chars to
 * avoid `is(`, `do(` false positives) followed by parentheses.
 *
 * Examples that match: `foo()`, `parser.parse(input)`, `MyClass.method(x, y)`
 * Examples that don't:  `(parens)`, `do (this)`, `it (foo)`
 */
const FUNCTION_CALL_RE = /\b[a-zA-Z_][\w$]{2,}(?:\.\w+)*\([^)]{0,200}\)/g;

/**
 * Sweep an array of regex source strings, returning the first hit and the
 * pattern that matched. Compiles regexes per call — acceptable because
 * pattern arrays are small (≤10 by schema) and regex compilation for
 * \\b-delimited keyword sets is microsecond-fast.
 *
 * Patterns that fail to compile are skipped silently; logging would
 * require coupling to a logger and turn this into a non-pure function.
 * Misconfigured patterns surface in tests/heuristics.test.ts coverage.
 */
function firstRegexHit(
  text: string,
  patterns: readonly string[],
): { pattern: string; matched: string } | undefined {
  for (const source of patterns) {
    let re: RegExp;
    try {
      re = new RegExp(source, "i");
    } catch {
      continue;
    }
    const m = re.exec(text);
    if (m !== null) {
      return { pattern: source, matched: m[0] };
    }
  }
  return undefined;
}

/**
 * Count global regex matches without keeping the matches themselves.
 * `String.prototype.matchAll` would allocate a full array; this version
 * just bumps a counter, keeping the heuristic allocation-light on long
 * prompts.
 */
function countMatches(text: string, re: RegExp): number {
  let count = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) {
    count += 1;
    if (count >= 10_000) {
      break;
    }
  }
  return count;
}

/**
 * Cap matched-substring length stored in the WAL. Patterns are usually
 * keyword regexes so matches are short, but a regex like `\b\w{50,}\b`
 * could catch a long token — clip so the WAL row stays readable.
 */
function truncateMatched(matched: string): string {
  const MAX = 40;
  return matched.length <= MAX ? matched : matched.slice(0, MAX) + "…";
}
