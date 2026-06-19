/**
 * Reversible compression (CCR).
 *
 * For a large text blob we keep a head and tail (where the signal usually is —
 * errors land at the end, intent at the start) and replace the middle with a
 * retrieval marker `<<ccr:HASH:N chars omitted>>`. The original is stored in
 * the CCR object store; an agent that needs the omitted middle calls the
 * `ccr_retrieve` tool (or `harness ccr retrieve`) with the handle.
 *
 * Small blobs are returned untouched — compression only pays off past a
 * threshold, and a marker on tiny content just adds noise.
 */
import { putOriginal } from "./store.js";

export interface CcrOptions {
  /** Below this length, return the text unchanged. */
  minChars?: number;
  /** Leading chars to keep verbatim. */
  headChars?: number;
  /** Trailing chars to keep verbatim. */
  tailChars?: number;
}

export interface CcrResult {
  compressed: string;
  /** Handle for the stored original, set only when compression happened. */
  hash?: string;
  originalChars: number;
  compressedChars: number;
  /** True when the blob was large enough to offload. */
  stored: boolean;
}

const DEFAULTS = { minChars: 2000, headChars: 600, tailChars: 400 };

/** Format the retrieval marker the agent learns to recognize. */
export function formatMarker(hash: string, omitted: number): string {
  return `<<ccr:${hash}:${omitted} chars omitted — call ccr_retrieve("${hash}") for the full content>>`;
}

/** Compress `text` reversibly, storing the original under `root` when large. */
export function compressReversible(root: string, text: string, opts: CcrOptions = {}): CcrResult {
  const { minChars, headChars, tailChars } = { ...DEFAULTS, ...opts };
  const originalChars = text.length;

  if (originalChars <= Math.max(minChars, headChars + tailChars + 64)) {
    return { compressed: text, originalChars, compressedChars: originalChars, stored: false };
  }

  const { hash } = putOriginal(root, text);
  const head = text.slice(0, headChars);
  const tail = text.slice(originalChars - tailChars);
  const omitted = originalChars - headChars - tailChars;
  const compressed = `${head}\n${formatMarker(hash, omitted)}\n${tail}`;

  return { compressed, hash, originalChars, compressedChars: compressed.length, stored: true };
}
