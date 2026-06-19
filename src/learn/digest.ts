/**
 * Build a token-bounded digest of parsed transcripts for the LLM.
 *
 * The digest is the expensive input, so it is shaped for signal density:
 * failures and their categories come first within each session, then user
 * prompts/interruptions (which reveal intent and friction), then a sample of
 * successful calls for context. We bound by characters (≈4 chars/token) and
 * note how much was truncated so the model knows the sample is partial.
 */
import type { SessionTrace } from "./types.js";

/** Default digest budget in characters (~15k tokens). */
export const DEFAULT_DIGEST_CHARS = 60_000;

function renderSession(trace: SessionTrace): string {
  const lines: string[] = [
    `=== Session ${trace.id} (${trace.toolCalls} calls, ${trace.failures} failures, ${trace.interruptions} interruptions) ===`,
  ];

  // Failures first — they carry the most learning signal.
  let idx = 0;
  for (const ev of trace.events) {
    if (ev.type === "tool" && ev.tool.isError) {
      lines.push(
        `  [${idx}] FAIL ${ev.tool.name} (${ev.tool.errorCategory}): ${ev.tool.inputSummary} → ${ev.tool.outputPreview}`,
      );
    }
    idx++;
  }

  // User intent + friction.
  for (const ev of trace.events) {
    if (ev.type === "user") {
      const tag = ev.turn.kind === "interruption" ? "INTERRUPT" : "USER";
      lines.push(`  ${tag}: ${ev.turn.text}`);
    }
  }

  // A light sample of successful tool usage for environment context.
  const ok = trace.events.filter((e) => e.type === "tool" && !e.tool.isError).slice(0, 12);
  for (const ev of ok) {
    if (ev.type === "tool") lines.push(`  ok ${ev.tool.name}: ${ev.tool.inputSummary}`);
  }
  return lines.join("\n");
}

/** Assemble the full digest, truncating to the character budget. */
export function buildDigest(
  traces: SessionTrace[],
  opts: { maxChars?: number } = {},
): { text: string; included: number; truncated: number } {
  const budget = opts.maxChars ?? DEFAULT_DIGEST_CHARS;
  // Sessions with more failures are more informative — prioritize them.
  const ordered = [...traces].sort((a, b) => b.failures - a.failures);

  const totals = traces.reduce(
    (acc, t) => ({ calls: acc.calls + t.toolCalls, failures: acc.failures + t.failures }),
    { calls: 0, failures: 0 },
  );
  const header = `Transcripts: ${traces.length} sessions, ${totals.calls} tool calls, ${totals.failures} failures\n`;

  const parts: string[] = [];
  let used = header.length;
  let included = 0;
  for (const trace of ordered) {
    const block = renderSession(trace);
    if (used + block.length > budget && included > 0) break;
    parts.push(block);
    used += block.length + 1;
    included++;
  }

  let text = header + parts.join("\n");
  const truncated = traces.length - included;
  if (truncated > 0) text += `\n\n... (${truncated} more session(s) truncated for budget)`;
  return { text, included, truncated };
}
