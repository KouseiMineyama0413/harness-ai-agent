/**
 * Shared agent sessions and prompt history.
 *
 * Sessions are the mechanism by which different agents (Claude, Codex,
 * humans) share working state: everything is plain files under
 * .harness/sessions/, so any tool that can read the repo can join.
 *
 *   <id>.json          session metadata (status, participating agents)
 *   <id>.events.jsonl  append-only event log (prompts, notes, decisions)
 *   <id>.handoff.md    generated handoff document for the next agent
 *   ACTIVE             pointer file holding the active session id
 *
 * Prompts are additionally appended to .harness/prompt_history.jsonl
 * (default on, config: session.promptHistory) — including when no session
 * is active — so prompt history survives across sessions and agents.
 * All stored text passes through secret redaction first.
 */
import fs from "node:fs";
import path from "node:path";
import { readIfExists, readJsonIfExists, writeJson, writeText } from "../core/fsutil.js";
import { redactSecrets } from "../guardrails/secrets.js";
import type { PromptHistoryEntry, Session, SessionEvent, SessionEventKind } from "../types.js";

export const SESSIONS_DIR = ".harness/sessions";
export const PROMPT_HISTORY_PATH = ".harness/prompt_history.jsonl";
const ACTIVE_POINTER = "ACTIVE";

function sessionsDir(root: string): string {
  return path.join(root, SESSIONS_DIR);
}
function sessionFile(root: string, id: string): string {
  return path.join(sessionsDir(root), `${id}.json`);
}
function eventsFile(root: string, id: string): string {
  return path.join(sessionsDir(root), `${id}.events.jsonl`);
}
function activePointer(root: string): string {
  return path.join(sessionsDir(root), ACTIVE_POINTER);
}

export function getActiveSession(root: string): Session | null {
  const id = readIfExists(activePointer(root))?.trim();
  if (!id) return null;
  const session = readJsonIfExists<Session>(sessionFile(root, id));
  return session && session.status === "active" ? session : null;
}

export function startSession(root: string, title: string, agent: string): Session {
  const active = getActiveSession(root);
  if (active) {
    throw new Error(
      `session ${active.id} ("${active.title}") is already active — agents join it automatically; run \`harness session end\` to close it`,
    );
  }
  fs.mkdirSync(sessionsDir(root), { recursive: true });
  const count = fs.readdirSync(sessionsDir(root)).filter((f) => /^S-\d+\.json$/.test(f)).length;
  const id = `S-${String(count + 1).padStart(3, "0")}`;
  const session: Session = {
    schemaVersion: 1,
    id,
    title,
    status: "active",
    startedAt: new Date().toISOString(),
    agents: [agent],
  };
  writeJson(sessionFile(root, id), session);
  writeText(activePointer(root), id + "\n");
  appendEvent(root, "status", `session started: ${title}`, agent, { promptHistory: false });
  return session;
}

export function endSession(root: string, agent: string): Session {
  const session = getActiveSession(root);
  if (!session) throw new Error("no active session");
  appendEvent(root, "status", "session ended", agent, { promptHistory: false });
  const closed: Session = { ...session, status: "closed", endedAt: new Date().toISOString() };
  writeJson(sessionFile(root, session.id), closed);
  fs.rmSync(activePointer(root), { force: true });
  return closed;
}

export interface AppendResult {
  sessionId: string | null;
  event: SessionEvent;
}

/**
 * Record an event. Writes to the active session's event log when one
 * exists; prompts additionally go to the global prompt history unless
 * opts.promptHistory is false.
 */
export function appendEvent(
  root: string,
  kind: SessionEventKind,
  text: string,
  agent: string,
  opts: { promptHistory?: boolean } = {},
): AppendResult {
  const event: SessionEvent = {
    ts: new Date().toISOString(),
    agent,
    kind,
    text: redactSecrets(text.trim()),
  };

  const session = getActiveSession(root);
  if (session) {
    fs.appendFileSync(eventsFile(root, session.id), JSON.stringify(event) + "\n", "utf8");
    if (!session.agents.includes(agent)) {
      writeJson(sessionFile(root, session.id), { ...session, agents: [...session.agents, agent] });
    }
  }

  if (kind === "prompt" && opts.promptHistory !== false) {
    const entry: PromptHistoryEntry = { ...event, sessionId: session?.id ?? null };
    const file = path.join(root, PROMPT_HISTORY_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  }

  return { sessionId: session?.id ?? null, event };
}

export function loadEvents(root: string, id: string): SessionEvent[] {
  const raw = readIfExists(eventsFile(root, id));
  if (!raw) return [];
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // A corrupt line must not take down the whole session.
    }
  }
  return events;
}

export function listSessions(root: string): Session[] {
  try {
    return fs
      .readdirSync(sessionsDir(root))
      .filter((f) => /^S-\d+\.json$/.test(f))
      .sort()
      .map((f) => readJsonIfExists<Session>(path.join(sessionsDir(root), f)))
      .filter((s): s is Session => s !== null);
  } catch {
    return [];
  }
}

export function loadSession(root: string, id: string): Session | null {
  return readJsonIfExists<Session>(sessionFile(root, id));
}

export function readPromptHistory(root: string, limit?: number): PromptHistoryEntry[] {
  const raw = readIfExists(path.join(root, PROMPT_HISTORY_PATH));
  if (!raw) return [];
  const entries: PromptHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as PromptHistoryEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return limit !== undefined && limit > 0 ? entries.slice(-limit) : entries;
}

/** Generate a handoff document so the next agent can continue the session. */
export function writeHandoff(root: string, agent: string, latestReport?: string): string {
  const session = getActiveSession(root);
  if (!session) throw new Error("no active session — nothing to hand off");

  appendEvent(root, "handoff", `handoff written by ${agent}`, agent, { promptHistory: false });
  const events = loadEvents(root, session.id);

  const byKind = (kind: SessionEventKind) => events.filter((e) => e.kind === kind);
  const fmt = (e: SessionEvent) => `- [${e.ts}] **${e.agent}**: ${e.text}`;

  const lines: string[] = [];
  lines.push(`# Handoff: ${session.title} (${session.id})`);
  lines.push("");
  lines.push(`- Started: ${session.startedAt}`);
  lines.push(`- Agents so far: ${session.agents.join(", ")}`);
  lines.push(`- Written by: ${agent} at ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## For the next agent");
  lines.push("- Read `.harness/context.md` first (refresh with `harness context`).");
  lines.push("- This session is still active — your events join it automatically.");
  lines.push(`- Full event log: \`${SESSIONS_DIR}/${session.id}.events.jsonl\``);
  lines.push(`- Prompt history: \`${PROMPT_HISTORY_PATH}\``);
  lines.push(`- Latest gate report: ${latestReport ?? "none — run `harness gate run`"}`);
  lines.push("");

  const decisions = byKind("decision");
  if (decisions.length > 0) {
    lines.push("## Decisions");
    decisions.forEach((e) => lines.push(fmt(e)));
    lines.push("");
  }
  const notes = byKind("note");
  if (notes.length > 0) {
    lines.push("## Notes");
    notes.forEach((e) => lines.push(fmt(e)));
    lines.push("");
  }
  const prompts = byKind("prompt").slice(-10);
  if (prompts.length > 0) {
    lines.push("## Recent prompts (last 10)");
    prompts.forEach((e) => lines.push(fmt(e)));
    lines.push("");
  }

  const file = path.join(sessionsDir(root), `${session.id}.handoff.md`);
  writeText(file, lines.join("\n"));
  return file;
}
