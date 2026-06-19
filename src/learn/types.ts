/**
 * Types for `harness learn` — failure mining over agent transcripts.
 *
 * The learn pipeline reads an agent's own conversation transcripts (the files
 * of record the agent harness already writes), extracts recurring failures and
 * environment facts, asks an LLM to distil them into actionable rules, and
 * folds those rules back into CLAUDE.md / the project profile. This closes the
 * loop: mistakes made in one session become guardrails for the next.
 *
 * Like the rest of the core, nothing here is vendor-specific: a transcript is
 * a normalized list of tool calls + user turns, regardless of which agent
 * produced it. Agent-specific parsing lives behind {@link TranscriptSource}.
 */

/** Coarse classification of a failed tool result, used to spot repeat failures. */
export type ErrorCategory =
  | "file_not_found"
  | "module_not_found"
  | "command_not_found"
  | "permission_denied"
  | "syntax_error"
  | "type_error"
  | "test_failure"
  | "timeout"
  | "network"
  | "git_conflict"
  | "non_zero_exit"
  | "other";

/** One normalized tool invocation parsed out of a transcript. */
export interface ToolCallRecord {
  /** Tool name, e.g. "Bash", "Edit", "Read". */
  name: string;
  /** One-line summary of the input (command, file path, …). */
  inputSummary: string;
  /** Whether the tool result was an error. */
  isError: boolean;
  /** Error classification when {@link isError}. */
  errorCategory?: ErrorCategory;
  /** Short preview of the (redacted) output for digest context. */
  outputPreview: string;
}

/** A user turn (typed prompt or an interruption signal). */
export interface UserTurn {
  kind: "prompt" | "interruption";
  text: string;
}

/** One parsed transcript: an ordered mix of tool calls and user turns. */
export interface SessionTrace {
  /** Source-specific session id (e.g. the transcript file stem). */
  id: string;
  /** Chronologically ordered events. */
  events: Array<{ type: "tool"; tool: ToolCallRecord } | { type: "user"; turn: UserTurn }>;
  toolCalls: number;
  failures: number;
  interruptions: number;
}

/** A single rule the LLM proposes from the mined transcripts. */
export interface LearnRecommendation {
  /** Section heading, e.g. "Environment", "Workflow", "File structure". */
  section: string;
  /** Markdown body — 1-3 terse bullets. */
  content: string;
  /** How many times the underlying pattern was observed. */
  evidenceCount: number;
  /** Rough estimate of prompt tokens saved per future session. */
  estimatedTokensSaved?: number;
}

/** Structured output of the LLM analysis step. */
export interface LearnAnalysis {
  /** Stable, repo-wide rules → CLAUDE.md managed block. */
  contextRules: LearnRecommendation[];
  /** Evolving, short lessons → project profile notes. */
  lessons: string[];
}

/** Final result of a learn run (after merge + write, or dry-run preview). */
export interface LearnResult {
  scannedTranscripts: number;
  totalToolCalls: number;
  totalFailures: number;
  analysis: LearnAnalysis;
  /** Files written (empty on dry run). */
  written: string[];
  /** True when nothing was persisted (preview only). */
  dryRun: boolean;
}
