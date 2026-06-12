/**
 * Model-specific operating instructions ("tuning packs").
 *
 * Claude Opus 4.8 is highly capable but has documented default behaviors
 * that cost performance in agentic work unless steered: it under-reaches
 * for tools/subagents/memory, asks for confirmation on minor decisions,
 * narrates more than needed, and follows severity filters so literally
 * that review recall drops. These rules — distilled from Anthropic's
 * published migration guidance — close most of that gap. They are injected
 * into context.md and SKILL.md so every agent turn carries them.
 */
import type { HarnessConfig } from "../config/schema.js";

const OPUS_48_RULES: string[] = [
  // Autonomy — cuts ask-rate without increasing over-reach.
  "For minor choices (naming, formatting, default values, which of two equivalent approaches), pick a reasonable option and note it rather than asking. Ask first only for scope changes or destructive actions.",
  // Completion — prevent text-only endings.
  "Before ending your turn, check your last paragraph. If it is a plan, a question you can answer yourself, or a promise about work you have not done, do that work now with tool calls.",
  // Tool triggering — 4.8 under-reaches for tools by default.
  "When the answer depends on information not already in the conversation (current repo state, versions, recent changes), verify with tools before answering — do not answer from memory.",
  // Subagent triggering — explicit fan-out guidance.
  "When work fans out across independent items (many files to read, many tests to run, many candidates to check), delegate to parallel subagents. Work directly for single-file reads or sequential edits.",
  // Memory surface — models perform measurably better with one.
  "Before any task longer than a few turns, read the project lessons in .harness/context.md. Record new non-obvious findings with `harness session note`/`decision` so they persist for future sessions.",
  // Up-front spec — long-horizon work needs the full goal in one turn.
  "Get the full task specification before starting long work: read the linked requirement and approved plan (or run `harness brief`) instead of discovering scope mid-run.",
  // Narration — silence default; 4.8 narrates more than needed.
  "Default to silence between tool calls: one sentence when you find something load-bearing, change direction, or hit a blocker. Do not narrate routine actions. Finish with one or two sentences on the outcome.",
  // Grounded progress — near-eliminates fabricated status reports.
  "Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; mark anything unverified as unverified.",
  // Boundaries.
  "When the user is describing a problem or asking a question, the deliverable is your assessment — report findings and stop. Do not apply fixes until asked.",
  // Verification cadence — fresh-context checks beat self-critique.
  "On long tasks, run `harness gate run --changed` at natural checkpoints, not only at the end; treat a failing required gate as the next task.",
  // Code review recall — counter literal severity-filtering.
  "When reviewing code, report every issue you find with a confidence and severity estimate; do not self-filter for importance — filtering happens downstream.",
];

/**
 * Resolve operating rules for the configured tuning target.
 * "auto" currently maps to the Opus 4.8 pack — the documented baseline for
 * agentic work; new packs (e.g. future models) plug in here.
 */
export function tuningRules(config: HarnessConfig): { target: string; rules: string[] } | null {
  const tuning = config.agent.tuning;
  if (tuning === "none") return null;
  return { target: "Claude Opus 4.8", rules: OPUS_48_RULES };
}
