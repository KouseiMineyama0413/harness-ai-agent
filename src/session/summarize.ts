/**
 * Session summarization: distill a session's event log into durable project
 * knowledge. The summary is written next to the session and appended to the
 * project profile's notes, so future `harness context` output carries the
 * lessons forward — this is how project knowledge accumulates automatically.
 */
import path from "node:path";
import { loadProfile, PROFILE_PATH } from "../analyze/analyzer.js";
import type { HarnessConfig } from "../config/schema.js";
import { writeJson, writeText } from "../core/fsutil.js";
import { resolveProvider } from "../llm/provider.js";
import { compress } from "../compress/router.js";
import type { Session, SessionEvent } from "../types.js";
import { appendEvent, getActiveSession, listSessions, loadEvents, SESSIONS_DIR } from "./store.js";

const SYSTEM_PROMPT = [
  "You distill software development session logs into durable project knowledge.",
  "Write in the language the session events are written in.",
  "Output exactly two sections:",
  "1. `## Summary` — 3-6 bullet points: what was done and key decisions with their rationale.",
  "2. `## Lessons` — 0-3 bullet points: only non-obvious facts a future engineer/agent working on this repo must know. Omit the section if there are none.",
  "Be concrete. Never invent information that is not in the log.",
].join("\n");

function renderEvents(events: SessionEvent[]): string {
  return events
    .filter((e) => e.kind !== "status")
    .map((e) => {
      // A pasted log/JSON/diff in an event can dwarf the rest of the prompt;
      // route it through the content compressors so the LLM sees the signal.
      const text = e.text.length > 1000 ? compress(e.text).compressed : e.text;
      return `[${e.ts}] ${e.agent} ${e.kind}: ${text}`;
    })
    .join("\n");
}

export async function summarizeSession(
  root: string,
  config: HarnessConfig,
  agent: string,
  sessionId?: string,
): Promise<{ session: Session; file: string; summary: string }> {
  const session = sessionId
    ? listSessions(root).find((s) => s.id === sessionId)
    : (getActiveSession(root) ?? listSessions(root).at(-1));
  if (!session) throw new Error(sessionId ? `session not found: ${sessionId}` : "no sessions exist yet");

  const events = loadEvents(root, session.id);
  if (events.filter((e) => e.kind !== "status").length === 0) {
    throw new Error(`session ${session.id} has no substantive events to summarize`);
  }

  const provider = resolveProvider(config.llm);
  const summary = await provider.complete(
    {
      system: SYSTEM_PROMPT,
      prompt: `Session "${session.title}" (${session.id}), agents: ${session.agents.join(", ")}\n\nEvent log:\n${renderEvents(events)}`,
      maxTokens: config.llm.maxTokens,
    },
    config.llm,
  );

  const file = path.join(root, SESSIONS_DIR, `${session.id}.summary.md`);
  writeText(file, `# ${session.title} (${session.id})\n\n${summary.trim()}\n`);

  // Fold lessons into the project profile so future context includes them.
  const profile = loadProfile(root);
  if (profile) {
    const note = `[${session.id}] ${session.title}: ${firstBullet(summary) ?? "summarized"}`;
    if (!profile.notes.includes(note)) {
      profile.notes.push(note);
      writeJson(path.join(root, PROFILE_PATH), profile);
    }
  }

  if (session.status === "active") {
    appendEvent(root, "note", `session summarized to ${session.id}.summary.md`, agent, {
      promptHistory: false,
    });
  }

  return { session, file, summary };
}

function firstBullet(summary: string): string | undefined {
  return summary
    .split("\n")
    .find((l) => l.trim().startsWith("-"))
    ?.trim()
    .replace(/^-\s*/, "");
}
