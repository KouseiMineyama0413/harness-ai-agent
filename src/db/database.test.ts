import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, endSession, startSession } from "../session/store.js";
import { HarnessDb } from "./database.js";

let root: string;
let db: HarnessDb;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-db-"));
  db = await HarnessDb.open(root);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function seed() {
  // Session 1: claude starts, codex joins.
  startSession(root, "CSV export", "claude");
  appendEvent(root, "prompt", "export orders as CSV", "claude");
  appendEvent(root, "decision", "stream rows", "claude");
  appendEvent(root, "note", "resuming from tests", "codex");
  endSession(root, "claude");

  // Session 2: codex only.
  startSession(root, "pagination", "codex");
  appendEvent(root, "prompt", "ページネーションを追加して", "codex");
  endSession(root, "codex");

  // Sessionless prompt.
  appendEvent(root, "prompt", "quick question about deploys", "human");
}

describe("HarnessDb", () => {
  it("reindexes sessions, events and prompts from files", () => {
    seed();
    const counts = db.reindex();
    expect(counts.sessions).toBe(2);
    expect(counts.prompts).toBe(3);
    expect(counts.events).toBeGreaterThanOrEqual(8); // 4 status + prompt/decision/note + prompt
  });

  it("reindex is idempotent (rebuild, not append)", () => {
    seed();
    const first = db.reindex();
    const second = db.reindex();
    expect(second).toEqual(first);
  });

  it("lists agents across sessions and prompt history", () => {
    seed();
    db.reindex();
    expect(db.listAgents()).toEqual(["claude", "codex", "human"]);
  });

  it("computes per-agent activity", () => {
    seed();
    db.reindex();
    const rows = db.agentActivity();

    const claude = rows.find((r) => r.agent === "claude");
    expect(claude).toMatchObject({ sessions: 1, prompts: 1, decisions: 1, notes: 0 });

    const codex = rows.find((r) => r.agent === "codex");
    expect(codex).toMatchObject({ sessions: 2, prompts: 1, notes: 1 });

    const human = rows.find((r) => r.agent === "human");
    expect(human).toMatchObject({ sessions: 0, prompts: 1 });
  });

  it("lists the sessions an agent participated in", () => {
    seed();
    db.reindex();

    const codexSessions = db.agentSessions("codex");
    expect(codexSessions.map((s) => s.id)).toEqual(["S-001", "S-002"]);
    expect(codexSessions[0]?.events).toBe(1); // only the note in S-001

    const claudeSessions = db.agentSessions("claude");
    expect(claudeSessions.map((s) => s.id)).toEqual(["S-001"]);
    expect(claudeSessions[0]?.title).toBe("CSV export");
  });

  it("searches prompts by substring, including Japanese, with agent filter", () => {
    seed();
    db.reindex();
    expect(db.searchPrompts("CSV")).toHaveLength(1);
    expect(db.searchPrompts("ページネーション")).toHaveLength(1);
    expect(db.searchPrompts("ページネーション", 50, "claude")).toHaveLength(0);
    expect(db.searchPrompts("ページネーション", 50, "codex")).toHaveLength(1);
  });

  it("escapes LIKE wildcards in search queries", () => {
    appendEvent(root, "prompt", "literal percent 100% done", "claude");
    appendEvent(root, "prompt", "unrelated", "claude");
    db.reindex();
    expect(db.searchPrompts("100%")).toHaveLength(1);
    expect(db.searchPrompts("%")).toHaveLength(1); // matches only the literal %
  });
});
