/**
 * Lossy context compressors (headroom's ContentRouter, in miniature).
 *
 * These shrink bulky tool output *before* it is sent to an LLM, trading exact
 * fidelity for tokens while preserving the signal that matters: errors in logs,
 * changed lines in diffs, structure in JSON. Unlike CCR (which is reversible),
 * these are one-way summaries — use them when the omitted detail is genuinely
 * noise, or pair them with CCR when it might be needed later.
 */

export type ContentType = "json" | "log" | "diff" | "text";

export interface CompressionResult {
  compressed: string;
  contentType: ContentType;
  originalChars: number;
  compressedChars: number;
  /** Fraction removed, 0..1 (0 = unchanged). */
  ratio: number;
}

export function makeResult(
  contentType: ContentType,
  original: string,
  compressed: string,
): CompressionResult {
  const originalChars = original.length;
  const compressedChars = compressed.length;
  return {
    compressed,
    contentType,
    originalChars,
    compressedChars,
    ratio: originalChars === 0 ? 0 : Math.max(0, 1 - compressedChars / originalChars),
  };
}
