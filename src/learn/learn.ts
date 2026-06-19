/**
 * `harness learn` orchestrator.
 *
 * Pipeline: collect transcripts → build digest → LLM analysis → (optionally)
 * write to CLAUDE.md + profile notes. With `apply: false` it previews without
 * writing, so a human can review before the guidance becomes load-bearing.
 */
import path from "node:path";
import { loadProfile } from "../analyze/analyzer.js";
import type { HarnessConfig } from "../config/schema.js";
import { readMarkedBlock } from "../core/markers.js";
import { analyzeDigest } from "./analyzer.js";
import { buildDigest } from "./digest.js";
import { collectTraces } from "./transcripts.js";
import type { LearnResult } from "./types.js";
import { LEARN_MARKER_ID, writeLearnResults } from "./writer.js";

export interface LearnOptions {
  /** Persist results. When false, returns a dry-run preview. */
  apply?: boolean;
  /** Max transcripts to scan (newest first). */
  limit?: number;
  /** Digest character budget. */
  maxChars?: number;
  /** ISO date stamp for the generated block (defaults to today). */
  date?: string;
}

export class NoTranscriptsError extends Error {}

export async function runLearn(
  root: string,
  config: HarnessConfig,
  opts: LearnOptions = {},
): Promise<LearnResult> {
  const traces = collectTraces(root, { limit: opts.limit });
  if (traces.length === 0) {
    throw new NoTranscriptsError(
      "no agent transcripts found for this project (looked under ~/.claude/projects/) — run some Claude Code sessions first",
    );
  }

  const totalToolCalls = traces.reduce((n, t) => n + t.toolCalls, 0);
  const totalFailures = traces.reduce((n, t) => n + t.failures, 0);
  const { text } = buildDigest(traces, { maxChars: opts.maxChars });

  const prior = readMarkedBlock(path.join(root, "CLAUDE.md"), LEARN_MARKER_ID) ?? undefined;
  const analysis = await analyzeDigest(config, text, prior);

  const apply = opts.apply ?? false;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  let written: string[] = [];
  if (apply && (analysis.contextRules.length > 0 || analysis.lessons.length > 0)) {
    // loadProfile is read lazily inside the writer; surface a hint if missing.
    if (analysis.lessons.length > 0 && !loadProfile(root)) {
      // Non-fatal: contextRules still write; lessons are simply skipped.
    }
    written = writeLearnResults(root, analysis, date);
  }

  return {
    scannedTranscripts: traces.length,
    totalToolCalls,
    totalFailures,
    analysis,
    written,
    dryRun: !apply,
  };
}
