/**
 * CJK-aware token estimator. Inlined here because the OpenClaw plugin SDK
 * does not currently re-export its internal tokenization utility (verified
 * against openclaw@2026.4.25 — see DESIGN.md §11). Replace this file with
 * the SDK helper if/when it becomes public.
 *
 * Approximation rationale:
 *   - English / ASCII / Latin scripts: BPE tokenizers (cl100k, o200k, etc.)
 *     average ~4 chars per token.
 *   - CJK (Chinese, Japanese kana, Korean Hangul): each character carries
 *     more semantic weight; modern tokenizers average ~1.5 chars per token
 *     in this range.
 *
 * The classifier and the long-context override (DESIGN.md §5) only need an
 * order-of-magnitude estimate — the 200K-token guard is a coarse threshold,
 * not an exact gate. Off-by-2x in either direction is acceptable; off-by-10x
 * is not. This estimator stays well within ±2x for typical mixed-script
 * prompts.
 *
 * Performance: O(n) single regex scan, ~µs per KB of prompt — negligible
 * even on the multi-MB end of the long-context spectrum.
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }
  // Hiragana U+3040–U+309F, Katakana U+30A0–U+30FF, CJK Unified Ideographs
  // U+4E00–U+9FFF, Hangul Syllables U+AC00–U+D7AF.
  const cjkMatches = text.match(/[\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/gu);
  const cjkChars = cjkMatches?.length ?? 0;
  const otherChars = text.length - cjkChars;
  return Math.ceil(otherChars / 4 + cjkChars / 1.5);
}
