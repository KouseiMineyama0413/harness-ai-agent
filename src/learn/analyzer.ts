/**
 * LLM analysis step: turn a transcript digest into structured rules.
 *
 * Reuses the harness LLM provider abstraction (API key or local Claude Code
 * session), so learn works wherever `harness session summarize` does. The model
 * is asked for strict JSON; we parse defensively because models wrap JSON in
 * prose or fences.
 */
import type { HarnessConfig } from "../config/schema.js";
import { resolveProvider } from "../llm/provider.js";
import type { LearnAnalysis, LearnRecommendation } from "./types.js";

const SYSTEM_PROMPT = [
  "You analyze AI coding-agent transcripts to prevent repeated mistakes.",
  "From the digest, extract durable, actionable guidance for future agents working in this repository.",
  "Look for: (1) environment rules (which commands/paths actually work vs fail),",
  "(2) repeated failure patterns and their upfront prevention,",
  "(3) explicit user preferences, corrections, or interruptions,",
  "(4) workflow rules that avoid wasted steps.",
  "",
  "Rules:",
  "- Only include a pattern with 2+ occurrences OR explicit user direction.",
  "- Every item must be specific and immediately actionable — no platitudes.",
  "- Write in the language the transcript is written in.",
  "- Separate stable repo-wide facts (contextRules) from short evolving lessons (lessons).",
  "",
  "Respond with ONLY a JSON object, no prose, no code fences:",
  '{ "contextRules": [ { "section": "Environment", "content": "- bullet\\n- bullet", "evidenceCount": 3, "estimatedTokensSaved": 200 } ], "lessons": ["short one-line lesson"] }',
  "If there is nothing worth recording, return {\"contextRules\":[],\"lessons\":[]}.",
].join("\n");

/** Extract the first balanced JSON object from a possibly-decorated string. */
function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

function coerceAnalysis(parsed: unknown): LearnAnalysis {
  const obj = (parsed ?? {}) as { contextRules?: unknown; lessons?: unknown };
  const rules: LearnRecommendation[] = Array.isArray(obj.contextRules)
    ? obj.contextRules
        .map((r) => r as Record<string, unknown>)
        .filter((r) => typeof r.section === "string" && typeof r.content === "string")
        .map((r) => ({
          section: String(r.section).trim(),
          content: String(r.content).trim(),
          evidenceCount: Number.isFinite(r.evidenceCount) ? Number(r.evidenceCount) : 1,
          estimatedTokensSaved: Number.isFinite(r.estimatedTokensSaved)
            ? Number(r.estimatedTokensSaved)
            : undefined,
        }))
    : [];
  const lessons: string[] = Array.isArray(obj.lessons)
    ? obj.lessons.filter((l): l is string => typeof l === "string" && l.trim().length > 0).map((l) => l.trim())
    : [];
  return { contextRules: rules, lessons };
}

/** Run the LLM analysis. `priorPatterns` is the existing managed block, if any. */
export async function analyzeDigest(
  config: HarnessConfig,
  digest: string,
  priorPatterns?: string,
): Promise<LearnAnalysis> {
  const provider = resolveProvider(config.llm);
  const prior = priorPatterns?.trim()
    ? `\n\n=== Already-recorded patterns (refine or extend, do not duplicate) ===\n${priorPatterns.trim()}`
    : "";
  const raw = await provider.complete(
    {
      system: SYSTEM_PROMPT,
      prompt: `Digest of recent agent sessions:\n\n${digest}${prior}`,
      maxTokens: Math.max(config.llm.maxTokens, 2048),
    },
    config.llm,
  );
  const json = extractJson(raw);
  if (!json) return { contextRules: [], lessons: [] };
  try {
    return coerceAnalysis(JSON.parse(json));
  } catch {
    return { contextRules: [], lessons: [] };
  }
}
