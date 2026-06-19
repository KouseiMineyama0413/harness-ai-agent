/**
 * SmartCrusher-lite: compress JSON, especially arrays of objects.
 *
 * Arrays of similar objects are the dominant shape of tool output (search hits,
 * API rows, file listings) and the most wasteful when pretty-printed: every row
 * repeats every key. We collapse them to a single key header plus tab-separated
 * value rows, and sample very long arrays (head + tail) with an omitted count.
 * Plain objects are minified. Anything unexpected falls back to minified JSON.
 */
import type { CompressionResult } from "./types.js";
import { makeResult } from "./types.js";

const DEFAULT_MAX_ROWS = 40;

function scalar(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function crushObjectArray(arr: Record<string, unknown>[], maxRows: number): string | null {
  if (arr.length === 0) return null;
  // Union of keys, preserving first-seen order.
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const obj of arr) {
    for (const k of Object.keys(obj)) {
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  if (keys.length === 0) return null;

  const rows = arr.length <= maxRows ? arr : [...arr.slice(0, maxRows - 10), ...arr.slice(-10)];
  const lines = [`${arr.length} objects, keys: ${keys.join(", ")}`, keys.join("\t")];
  let i = 0;
  for (const obj of rows) {
    if (arr.length > maxRows && i === maxRows - 10) {
      lines.push(`… ${arr.length - maxRows} rows omitted …`);
    }
    lines.push(keys.map((k) => (k in obj ? scalar(obj[k]) : "")).join("\t"));
    i++;
  }
  return lines.join("\n");
}

export function compressJson(text: string, opts: { maxRows?: number } = {}): CompressionResult {
  const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return makeResult("json", text, text);
  }

  if (Array.isArray(parsed)) {
    const allObjects = parsed.length > 0 && parsed.every((e) => e && typeof e === "object" && !Array.isArray(e));
    if (allObjects) {
      const crushed = crushObjectArray(parsed as Record<string, unknown>[], maxRows);
      if (crushed) return makeResult("json", text, crushed);
    }
    // Array of scalars (or mixed): sample head + tail.
    if (parsed.length > maxRows) {
      const head = parsed.slice(0, maxRows - 10).map(scalar);
      const tail = parsed.slice(-10).map(scalar);
      const out = `${parsed.length} items: ${head.join(", ")} … ${parsed.length - maxRows} omitted … ${tail.join(", ")}`;
      return makeResult("json", text, out);
    }
  }

  // Fallback: minify (drops pretty-print whitespace).
  try {
    return makeResult("json", text, JSON.stringify(parsed));
  } catch {
    return makeResult("json", text, text);
  }
}
