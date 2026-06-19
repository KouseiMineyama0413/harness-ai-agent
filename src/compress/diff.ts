/**
 * DiffCompressor: keep what changed, trim the unchanged context.
 *
 * A unified diff carries large runs of unchanged context lines (prefixed with a
 * space) that the model rarely needs in full. We keep every header, hunk
 * marker, and +/- line, and shrink long context runs to a few lines on each
 * side with an `… N unchanged …` marker.
 */
import type { CompressionResult } from "./types.js";
import { makeResult } from "./types.js";

export function compressDiff(text: string, opts: { context?: number } = {}): CompressionResult {
  const context = opts.context ?? 3;
  const lines = text.split("\n");
  const out: string[] = [];
  let ctx: string[] = [];

  const flushContext = () => {
    if (ctx.length <= context * 2) {
      out.push(...ctx);
    } else {
      out.push(...ctx.slice(0, context));
      out.push(`… ${ctx.length - context * 2} unchanged …`);
      out.push(...ctx.slice(-context));
    }
    ctx = [];
  };

  for (const line of lines) {
    // Context lines start with a single space (and unified-diff blank lines).
    if (line.startsWith(" ") || line === "") {
      ctx.push(line);
      continue;
    }
    // Headers, +, -, and "\ No newline" lines are all kept verbatim.
    flushContext();
    out.push(line);
  }
  flushContext();

  return makeResult("diff", text, out.join("\n"));
}
