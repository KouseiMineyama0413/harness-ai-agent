/**
 * Content router: detect the content type and apply the matching compressor.
 *
 * Mirrors headroom's ContentRouter at a small scale — one deterministic
 * detect → strategy mapping, with an identity fallback for plain text. A guard
 * keeps the result only when it actually shrank the input, so routing never
 * makes content larger.
 */
import { compressDiff } from "./diff.js";
import { detectContentType } from "./detect.js";
import { compressJson } from "./json.js";
import { compressLog } from "./log.js";
import type { CompressionResult, ContentType } from "./types.js";
import { makeResult } from "./types.js";

export interface RouteOptions {
  /** Skip compression below this length. */
  minChars?: number;
  /** Force a content type instead of detecting. */
  as?: ContentType;
}

/** Compress text using the best-fit strategy for its detected type. */
export function compress(text: string, opts: RouteOptions = {}): CompressionResult {
  const minChars = opts.minChars ?? 500;
  if (text.length < minChars) return makeResult(detectContentType(text), text, text);

  const type = opts.as ?? detectContentType(text);
  let result: CompressionResult;
  switch (type) {
    case "json":
      result = compressJson(text);
      break;
    case "log":
      result = compressLog(text);
      break;
    case "diff":
      result = compressDiff(text);
      break;
    default:
      result = makeResult("text", text, text);
  }

  // Never emit something larger than the input.
  return result.compressedChars <= text.length ? result : makeResult(type, text, text);
}
