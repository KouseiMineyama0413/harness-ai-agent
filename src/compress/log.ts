/**
 * LogCompressor: keep the signal, drop the scroll.
 *
 * Build/test/CI logs are mostly progress noise around a few load-bearing
 * lines (errors, warnings, failures). We always keep those, plus a head and
 * tail for context, and replace skipped runs with an `… N lines …` marker.
 * Consecutive identical lines are collapsed with a `(×N)` count.
 */
import type { CompressionResult } from "./types.js";
import { makeResult } from "./types.js";

const IMPORTANT = /\b(error|warn|warning|fatal|exception|traceback|fail(ed|ure)?|panic|✖|❌)\b/i;

export function compressLog(
  text: string,
  opts: { headLines?: number; tailLines?: number } = {},
): CompressionResult {
  const headLines = opts.headLines ?? 10;
  const tailLines = opts.tailLines ?? 10;
  const lines = text.split("\n");
  if (lines.length <= headLines + tailLines + 4) return makeResult("log", text, text);

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (i < headLines || i >= lines.length - tailLines || IMPORTANT.test(lines[i]!)) keep[i] = true;
  }

  const out: string[] = [];
  let skipped = 0;
  let prev: string | null = null;
  let dupCount = 0;

  const flushDup = () => {
    if (prev !== null) {
      out.push(dupCount > 1 ? `${prev} (×${dupCount})` : prev);
      prev = null;
      dupCount = 0;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      skipped++;
      continue;
    }
    if (skipped > 0) {
      flushDup();
      out.push(`… ${skipped} lines …`);
      skipped = 0;
    }
    const line = lines[i]!;
    if (line === prev) {
      dupCount++;
    } else {
      flushDup();
      prev = line;
      dupCount = 1;
    }
  }
  flushDup();
  if (skipped > 0) out.push(`… ${skipped} lines …`);

  return makeResult("log", text, out.join("\n"));
}
