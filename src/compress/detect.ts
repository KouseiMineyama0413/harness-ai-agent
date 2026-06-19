/**
 * Cheap content-type detection. Order matters: diff and JSON have strong
 * structural signatures, so test those before falling back to log/text.
 */
import type { ContentType } from "./types.js";

export function detectContentType(text: string): ContentType {
  const trimmed = text.trimStart();

  // Unified diff: file markers or hunk headers near the top.
  if (/^(diff --git |--- |\+\+\+ |@@ )/m.test(text.slice(0, 2000)) && /^@@ /m.test(text)) {
    return "diff";
  }

  // JSON: starts with a bracket/brace and actually parses.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // not valid JSON — fall through
    }
  }

  // Log: many lines, with timestamps / level tags / repeated structure.
  const lines = text.split("\n");
  if (lines.length >= 8) {
    const logish = lines.filter((l) =>
      /\b(error|warn|warning|info|debug|trace|fatal)\b/i.test(l) ||
      /^\s*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(l) ||
      /^\s*\[\d{2}:\d{2}:\d{2}/.test(l),
    ).length;
    if (logish >= Math.max(3, lines.length * 0.15)) return "log";
  }

  return "text";
}
