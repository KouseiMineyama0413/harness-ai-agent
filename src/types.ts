/**
 * Core domain types shared across the harness.
 * These types are intentionally framework-agnostic: nothing here knows
 * about Node, Python, React, etc. Stack-specific knowledge lives in adapters.
 */

/** A technology detected in the target repository. */
export interface DetectedTechnology {
  /** Stable identifier, e.g. "node", "python", "nextjs", "postgres". */
  id: string;
  /** Human readable name. */
  name: string;
  /** "language" | "framework" | "database" | "infra" | "tooling" */
  kind: "language" | "framework" | "database" | "infra" | "tooling";
  /** Version string if it could be determined. */
  version?: string;
  /** Evidence files / keys that led to this detection (for human review). */
  evidence: string[];
  /** 0..1 confidence score. */
  confidence: number;
}

/** Identifiers of quality gates the harness knows how to run. */
export type GateId =
  | "lint"
  | "typecheck"
  | "test"
  | "build"
  | "security"
  | "deps"
  | "coverage";

export const ALL_GATE_IDS: GateId[] = [
  "lint",
  "typecheck",
  "test",
  "build",
  "security",
  "deps",
  "coverage",
];

/** A concrete, runnable command for a gate, with provenance. */
export interface ResolvedGate {
  id: GateId;
  command: string;
  /** Where the command came from. */
  source: "config" | "adapter" | "default";
  required: boolean;
  timeoutSec: number;
}

/** Result of executing one gate. */
export interface GateResult {
  id: GateId;
  status: "passed" | "failed" | "skipped" | "error" | "timeout";
  command?: string;
  exitCode?: number;
  durationMs: number;
  /** Redacted, truncated output suitable for reports. */
  output: string;
  /** Why the gate was skipped or errored. */
  reason?: string;
  required: boolean;
}

/** Persisted project knowledge: .harness/project_profile.json */
export interface ProjectProfile {
  schemaVersion: 1;
  generatedAt: string;
  root: string;
  name: string;
  technologies: DetectedTechnology[];
  /** Commands the harness inferred (before config overrides). */
  inferredCommands: Partial<Record<GateId, string>>;
  /** Top-level layout summary: dir -> short description. */
  layout: Record<string, string>;
  /** Entry points / notable files. */
  notableFiles: string[];
  /** Free-form notes a human or agent appended. Never overwritten by analyze. */
  notes: string[];
}

/** Structured context handed to an AI agent. */
export interface AgentContext {
  schemaVersion: 1;
  generatedAt: string;
  project: {
    name: string;
    root: string;
    technologies: DetectedTechnology[];
    layout: Record<string, string>;
    notableFiles: string[];
  };
  commands: Partial<Record<GateId, string>>;
  guardrails: {
    changeBudget: { maxFiles: number; maxLinesAdded: number; maxLinesDeleted: number };
    protectedPaths: string[];
    requirePlan: boolean;
    rules: string[];
  };
  git?: {
    branch?: string;
    dirtyFiles?: number;
  };
  /** Active shared session, so any agent can pick up where another left off. */
  session?: {
    id: string;
    title: string;
    agents: string[];
    recentEvents: SessionEvent[];
  };
}

/** Outcome of checking a shell command against the safety policy. */
export interface CommandVerdict {
  command: string;
  verdict: "allow" | "confirm" | "deny";
  /** Matched rule descriptions, empty when allowed. */
  reasons: string[];
}

/** Diff-level guardrail check result. */
export interface DiffCheckResult {
  ok: boolean;
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  violations: string[];
  /** Files matching protectedPaths that were touched. */
  protectedTouched: string[];
  /** Files in which potential secrets were introduced. */
  secretFindings: { file: string; line: number; kind: string }[];
}

/** Kinds of events recorded in a shared agent session. */
export type SessionEventKind = "prompt" | "note" | "decision" | "handoff" | "status";

export interface SessionEvent {
  ts: string;
  /** Who produced the event: "claude", "codex", "human", ... */
  agent: string;
  kind: SessionEventKind;
  /** Secret-redacted text. */
  text: string;
}

/** Per-agent activity summary computed from the SQLite index. */
export interface AgentActivity {
  agent: string;
  sessions: number;
  prompts: number;
  decisions: number;
  notes: number;
  lastActive: string | null;
}

/** One session as seen from a single agent's perspective. */
export interface AgentSessionSummary {
  id: string;
  title: string;
  status: "active" | "closed";
  startedAt: string;
  /** Events this agent recorded in the session. */
  events: number;
  /** Timestamp of this agent's last event in the session. */
  lastEventAt: string | null;
}

/** A work session shared between agents (Claude, Codex, humans). */
export interface Session {
  schemaVersion: 1;
  id: string;
  title: string;
  status: "active" | "closed";
  startedAt: string;
  endedAt?: string;
  /** Agents that have recorded at least one event. */
  agents: string[];
}

/** One line of .harness/prompt_history.jsonl */
export interface PromptHistoryEntry extends SessionEvent {
  sessionId: string | null;
}

/** A structured feature requirement document. */
export interface Requirement {
  schemaVersion: 1;
  id: string;
  title: string;
  status: "draft" | "approved" | "implemented" | "verified";
  createdAt: string;
  summary: string;
  userStories: string[];
  acceptanceCriteria: string[];
  nonFunctional: string[];
  outOfScope: string[];
  openQuestions: string[];
}

/** One harness run report (gate run / analyze / guard). */
export interface RunReport {
  schemaVersion: 1;
  kind: "gate" | "analyze" | "guard";
  generatedAt: string;
  project: string;
  summary: string;
  passed: boolean;
  gates?: GateResult[];
  details?: unknown;
  unresolvedRisks: string[];
  nextSteps: string[];
}
