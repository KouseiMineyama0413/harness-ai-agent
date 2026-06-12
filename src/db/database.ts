/**
 * SQLite query index over the file-based harness state, organized around
 * AGENTS: which agent (claude, codex, human, ...) ran which sessions,
 * recorded which prompts/decisions, and when.
 *
 * Design: files stay the source of truth (git-reviewable, agent-readable);
 * the database at .harness/cache/harness.db is a disposable index rebuilt
 * from sessions/*.json, *.events.jsonl and prompt_history.jsonl. It is
 * git-ignored — losing it costs nothing (`harness reindex`).
 *
 * Uses the built-in node:sqlite (Node >= 22.5, no native dependency).
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { listSessions, loadEvents, readPromptHistory } from "../session/store.js";
import type { AgentActivity, AgentSessionSummary } from "../types.js";

export const DB_PATH = ".harness/cache/harness.db";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  agents TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE TABLE IF NOT EXISTS prompts (
  ts TEXT NOT NULL,
  agent TEXT NOT NULL,
  session_id TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_agent ON prompts(agent);
`;

export interface ReindexCounts {
  sessions: number;
  events: number;
  prompts: number;
}

export interface PromptSearchHit {
  ts: string;
  agent: string;
  sessionId: string | null;
  text: string;
}

export class HarnessDb {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly root: string,
  ) {}

  static async open(root: string): Promise<HarnessDb> {
    // process.getBuiltinModule bypasses bundlers/test runners (vite-node)
    // that cannot resolve the node:sqlite specifier themselves.
    let mod: typeof import("node:sqlite") | undefined;
    try {
      mod = process.getBuiltinModule?.("node:sqlite") ?? (await import("node:sqlite"));
    } catch {
      mod = undefined;
    }
    if (!mod) {
      throw new Error(
        "node:sqlite is unavailable — Node.js >= 22.5 is required " +
          "(on 22.5–22.12 run node with --experimental-sqlite; current: " +
          process.version +
          ")",
      );
    }
    const file = path.join(root, DB_PATH);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new mod.DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    return new HarnessDb(db, root);
  }

  /** Rebuild the entire index from the files of record, atomically. */
  reindex(): ReindexCounts {
    const sessions = listSessions(this.root);
    const prompts = readPromptHistory(this.root);

    const counts: ReindexCounts = { sessions: 0, events: 0, prompts: 0 };
    this.db.exec("BEGIN;");
    try {
      this.db.exec("DELETE FROM sessions; DELETE FROM events; DELETE FROM prompts;");

      const insSession = this.db.prepare(
        "INSERT INTO sessions (id, title, status, started_at, ended_at, agents) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insEvent = this.db.prepare(
        "INSERT INTO events (session_id, ts, agent, kind, text) VALUES (?, ?, ?, ?, ?)",
      );
      const insPrompt = this.db.prepare(
        "INSERT INTO prompts (ts, agent, session_id, text) VALUES (?, ?, ?, ?)",
      );

      for (const s of sessions) {
        insSession.run(s.id, s.title, s.status, s.startedAt, s.endedAt ?? null, s.agents.join(","));
        counts.sessions++;
        for (const e of loadEvents(this.root, s.id)) {
          insEvent.run(s.id, e.ts, e.agent, e.kind, e.text);
          counts.events++;
        }
      }
      for (const p of prompts) {
        insPrompt.run(p.ts, p.agent, p.sessionId, p.text);
        counts.prompts++;
      }
      this.db.exec("COMMIT;");
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
    return counts;
  }

  /** Distinct agents observed across sessions and prompt history. */
  listAgents(): string[] {
    const rows = this.db
      .prepare("SELECT agent FROM events UNION SELECT agent FROM prompts ORDER BY agent")
      .all() as { agent: string }[];
    return rows.map((r) => r.agent);
  }

  /** Per-agent activity across all sessions and prompt history. */
  agentActivity(): AgentActivity[] {
    const byAgent = new Map<string, AgentActivity>();
    const get = (agent: string): AgentActivity => {
      let row = byAgent.get(agent);
      if (!row) {
        row = { agent, sessions: 0, prompts: 0, decisions: 0, notes: 0, lastActive: null };
        byAgent.set(agent, row);
      }
      return row;
    };
    const bump = (row: AgentActivity, ts: string | null) => {
      if (ts && (!row.lastActive || ts > row.lastActive)) row.lastActive = ts;
    };

    const eventRows = this.db
      .prepare(
        "SELECT agent, COUNT(DISTINCT session_id) AS sessions, " +
          "SUM(CASE WHEN kind = 'decision' THEN 1 ELSE 0 END) AS decisions, " +
          "SUM(CASE WHEN kind = 'note' THEN 1 ELSE 0 END) AS notes, " +
          "MAX(ts) AS last FROM events GROUP BY agent",
      )
      .all() as { agent: string; sessions: number; decisions: number; notes: number; last: string }[];
    for (const r of eventRows) {
      const row = get(r.agent);
      row.sessions = r.sessions;
      row.decisions = r.decisions;
      row.notes = r.notes;
      bump(row, r.last);
    }

    // Prompt counts come from the prompt history table only — prompts made
    // during a session also exist in events, counting both would double them.
    const promptRows = this.db
      .prepare("SELECT agent, COUNT(*) AS prompts, MAX(ts) AS last FROM prompts GROUP BY agent")
      .all() as { agent: string; prompts: number; last: string }[];
    for (const r of promptRows) {
      const row = get(r.agent);
      row.prompts = r.prompts;
      bump(row, r.last);
    }

    return [...byAgent.values()].sort((a, b) =>
      (b.lastActive ?? "").localeCompare(a.lastActive ?? ""),
    );
  }

  /** Sessions a given agent participated in, with that agent's footprint. */
  agentSessions(agent: string): AgentSessionSummary[] {
    const rows = this.db
      .prepare(
        "SELECT s.id, s.title, s.status, s.started_at, " +
          "COUNT(e.rowid) AS events, MAX(e.ts) AS last " +
          "FROM sessions s JOIN events e ON e.session_id = s.id " +
          "WHERE e.agent = ? GROUP BY s.id ORDER BY s.id",
      )
      .all(agent) as {
      id: string;
      title: string;
      status: "active" | "closed";
      started_at: string;
      events: number;
      last: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      startedAt: r.started_at,
      events: r.events,
      lastEventAt: r.last,
    }));
  }

  /** Substring search over prompt history (works well for CJK text too). */
  searchPrompts(query: string, limit = 50, agent?: string): PromptSearchHit[] {
    const escaped = query.replace(/[\\%_]/g, (c) => "\\" + c);
    const rows = this.db
      .prepare(
        "SELECT ts, agent, session_id, text FROM prompts " +
          "WHERE text LIKE ? ESCAPE '\\' " +
          (agent ? "AND agent = ? " : "") +
          "ORDER BY ts DESC LIMIT ?",
      )
      .all(...(agent ? [`%${escaped}%`, agent, limit] : [`%${escaped}%`, limit])) as {
      ts: string;
      agent: string;
      session_id: string | null;
      text: string;
    }[];
    return rows.map((r) => ({ ts: r.ts, agent: r.agent, sessionId: r.session_id, text: r.text }));
  }

  close(): void {
    this.db.close();
  }
}
