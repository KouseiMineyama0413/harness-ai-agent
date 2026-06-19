/**
 * Cache prefix alignment — detect volatile content that breaks provider
 * KV-cache prefixes.
 *
 * Anthropic/OpenAI cache a request by its longest stable *prefix*. A single
 * UUID, timestamp, JWT, or content hash near the top of a long, otherwise
 * stable prompt invalidates the whole cached prefix, so every call re-pays for
 * tokens that never changed. The harness generates exactly this kind of prompt
 * (context.md, briefs, the skill), so it pays to know where the volatility is.
 *
 * Following headroom's design, this module never rewrites content — it only
 * detects and scores, so callers can decide whether to move volatile fields to
 * the end (the "live zone") themselves. Detection is heuristic and whitespace-
 * tokenized; false negatives are fine, the goal is a cheap cache-health signal.
 */

export type VolatileKind = "uuid" | "iso8601" | "jwt" | "hex_hash";

export interface VolatileFinding {
  token: string;
  kind: VolatileKind;
  /** Character offset of the token in the source text. */
  offset: number;
}

export interface AlignmentReport {
  findings: VolatileFinding[];
  /** 0-100; 100 = no volatile content detected. */
  score: number;
  /** Chars before the first volatile token — the cache-stable prefix length. */
  stablePrefixChars: number;
  /** Total chars scanned. */
  totalChars: number;
}

function isUuid(t: string): boolean {
  // Canonical RFC 4122 form only (36 chars, 4 dashes) so we don't confuse a
  // bare 32-char hex MD5 for a UUID — that is handled by isHexHash.
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(t);
}

function isIso8601(t: string): boolean {
  // Require a date-ish shape, then confirm it actually parses to a real date.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(t)) return false;
  const ms = Date.parse(t);
  return Number.isFinite(ms);
}

function isJwtShape(t: string): boolean {
  const parts = t.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length >= 4 && /^[A-Za-z0-9_-]+$/.test(p));
}

function isHexHash(t: string): boolean {
  return (t.length === 32 || t.length === 40 || t.length === 64) && /^[0-9a-fA-F]+$/.test(t);
}

function classify(token: string): VolatileKind | null {
  if (isUuid(token)) return "uuid";
  if (isJwtShape(token)) return "jwt";
  if (isIso8601(token)) return "iso8601";
  if (isHexHash(token)) return "hex_hash";
  return null;
}

const STRIP = /^[.,;:!?"'()[\]{}<>]+|[.,;:!?"'()[\]{}<>]+$/g;

/** Scan text for volatile tokens and produce a cache-alignment report. */
export function analyzeAlignment(text: string): AlignmentReport {
  const findings: VolatileFinding[] = [];
  const tokenRe = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const raw = m[0];
    const cleaned = raw.replace(STRIP, "");
    if (!cleaned) continue;
    const kind = classify(cleaned);
    if (kind) {
      const inner = m.index + raw.indexOf(cleaned);
      findings.push({ token: cleaned, kind, offset: inner });
    }
  }
  const score = Math.max(0, 100 - 10 * findings.length);
  const stablePrefixChars = findings.length > 0 ? findings[0]!.offset : text.length;
  return { findings, score, stablePrefixChars, totalChars: text.length };
}

/** One-line human summary of a report, or null when perfectly aligned. */
export function summarizeAlignment(report: AlignmentReport): string | null {
  if (report.findings.length === 0) return null;
  const counts = new Map<VolatileKind, number>();
  for (const f of report.findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  const breakdown = [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(", ");
  const stablePct = Math.round((report.stablePrefixChars / Math.max(1, report.totalChars)) * 100);
  return `volatile content (${breakdown}); cache score ${report.score}/100, stable prefix ${stablePct}%`;
}
