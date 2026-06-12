import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendEvent,
  endSession,
  getActiveSession,
  listSessions,
  loadEvents,
  readPromptHistory,
  startSession,
  writeHandoff,
} from "./store.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-session-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("session lifecycle", () => {
  it("starts, joins agents across tools, and ends", () => {
    const s = startSession(root, "implement CSV export", "claude");
    expect(s.id).toBe("S-001");
    expect(getActiveSession(root)?.id).toBe("S-001");

    // A different agent (codex) appends to the same session — this is the sharing mechanism.
    appendEvent(root, "decision", "use streaming CSV writer", "codex");
    expect(getActiveSession(root)?.agents).toEqual(["claude", "codex"]);

    const events = loadEvents(root, "S-001");
    expect(events.some((e) => e.agent === "codex" && e.kind === "decision")).toBe(true);

    const closed = endSession(root, "claude");
    expect(closed.status).toBe("closed");
    expect(getActiveSession(root)).toBeNull();
    expect(listSessions(root)).toHaveLength(1);
  });

  it("refuses to start a second active session", () => {
    startSession(root, "task A", "claude");
    expect(() => startSession(root, "task B", "codex")).toThrow(/already active/);
  });
});

describe("prompt history", () => {
  it("records prompts by default, even without an active session", () => {
    appendEvent(root, "prompt", "add pagination to /orders", "codex");
    const history = readPromptHistory(root);
    expect(history).toHaveLength(1);
    expect(history[0]?.sessionId).toBeNull();

    startSession(root, "pagination", "codex");
    appendEvent(root, "prompt", "also sort by date desc", "claude");
    expect(readPromptHistory(root)).toHaveLength(2);
    expect(readPromptHistory(root)[1]?.sessionId).toBe("S-001");
  });

  it("can be suppressed per event and redacts secrets", () => {
    appendEvent(root, "prompt", "internal", "human", { promptHistory: false });
    expect(readPromptHistory(root)).toHaveLength(0);

    appendEvent(root, "prompt", "use key AKIAIOSFODNN7EXAMPLE please", "claude"); // harness-allow-secret
    const entry = readPromptHistory(root)[0];
    expect(entry?.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(entry?.text).toContain("[REDACTED:aws-access-key]");
  });

  it("respects --limit and skips corrupt lines", () => {
    for (let i = 1; i <= 5; i++) appendEvent(root, "prompt", `prompt ${i}`, "claude");
    fs.appendFileSync(path.join(root, ".harness/prompt_history.jsonl"), "not json\n");
    const last2 = readPromptHistory(root, 2);
    expect(last2.map((e) => e.text)).toEqual(["prompt 4", "prompt 5"]);
  });
});

describe("handoff", () => {
  it("writes a handoff document containing decisions and prompts", () => {
    startSession(root, "CSV export", "claude");
    appendEvent(root, "prompt", "export orders as CSV", "claude");
    appendEvent(root, "decision", "stream rows, no in-memory buffer", "claude");

    const file = writeHandoff(root, "claude");
    const doc = fs.readFileSync(file, "utf8");
    expect(doc).toContain("# Handoff: CSV export (S-001)");
    expect(doc).toContain("stream rows, no in-memory buffer");
    expect(doc).toContain("export orders as CSV");
    // The handoff itself is logged so the next agent sees it happened.
    expect(loadEvents(root, "S-001").some((e) => e.kind === "handoff")).toBe(true);
  });

  it("fails without an active session", () => {
    expect(() => writeHandoff(root, "codex")).toThrow(/no active session/);
  });
});
