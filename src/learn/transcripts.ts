/**
 * Claude Code transcript source.
 *
 * Claude Code records each session as a JSONL file under
 *   ~/.claude/projects/<escaped-cwd>/<uuid>.jsonl
 * where <escaped-cwd> is the absolute project path with every non-alphanumeric
 * character replaced by "-". Each line is one event; the ones we care about:
 *
 *   { type: "assistant", message: { content: [ { type: "tool_use", name, input } ] } }
 *   { type: "user",      message: { content: [ { type: "tool_result", content, is_error } ] } }
 *   { type: "user",      message: { content: "<typed prompt>" } }
 *
 * We normalize these into {@link SessionTrace}s. The directory layout is the
 * only Claude-specific knowledge here; everything downstream is agent-agnostic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../guardrails/secrets.js";
import { classifyError, looksLikeError } from "./classify.js";
import type { SessionTrace, ToolCallRecord } from "./types.js";

const INTERRUPT_MARKER = "[Request interrupted by user";

/** The directory Claude Code uses for a given project root, if it exists. */
export function claudeTranscriptDir(root: string, home = os.homedir()): string | null {
  const base = path.join(home, ".claude", "projects");
  if (!fs.existsSync(base)) return null;

  const escaped = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
  const direct = path.join(base, escaped);
  if (fs.existsSync(direct)) return direct;

  // Fallback: tolerate escaping drift across Claude Code versions by matching
  // a directory that decodes back to the same path (dashes are ambiguous, so
  // compare on the escaped form of each candidate).
  for (const entry of fs.readdirSync(base)) {
    if (entry.replace(/[^a-zA-Z0-9]/g, "-") === escaped) return path.join(base, entry);
  }
  return null;
}

/** List transcript files for a project, newest first, capped at `limit`. */
export function listTranscripts(dir: string, limit?: number): string[] {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .map((f) => ({ f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.f);
  return limit ? files.slice(0, limit) : files;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .join(" ");
  }
  return "";
}

function summarizeInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return name;
  const pick =
    input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.description;
  const text = typeof pick === "string" ? pick : JSON.stringify(input);
  return text.replace(/\s+/g, " ").slice(0, 160);
}

interface RawLine {
  type?: string;
  message?: { content?: unknown };
}

/** Parse one transcript file into a normalized trace. */
export function parseTranscript(file: string): SessionTrace {
  const id = path.basename(file).replace(/\.jsonl$/, "");
  const trace: SessionTrace = { id, events: [], toolCalls: 0, failures: 0, interruptions: 0 };
  // tool_use id -> name, so a later tool_result can be attributed.
  const pending = new Map<string, ToolCallRecord>();

  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let d: RawLine;
    try {
      d = JSON.parse(line) as RawLine;
    } catch {
      continue;
    }
    const content = d.message?.content;

    if (d.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
          const tu = b as { id?: string; name?: string; input?: Record<string, unknown> };
          const rec: ToolCallRecord = {
            name: tu.name ?? "unknown",
            inputSummary: redactSecrets(summarizeInput(tu.name ?? "", tu.input)),
            isError: false,
            outputPreview: "",
          };
          if (tu.id) pending.set(tu.id, rec);
          trace.events.push({ type: "tool", tool: rec });
          trace.toolCalls++;
        }
      }
      continue;
    }

    if (d.type === "user") {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || typeof b !== "object") continue;
          const block = b as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
          if (block.type === "tool_result") {
            const out = blockText(block.content);
            const isError = block.is_error === true || looksLikeError(out);
            const rec = block.tool_use_id ? pending.get(block.tool_use_id) : undefined;
            if (rec) {
              rec.isError = isError;
              rec.outputPreview = redactSecrets(out).replace(/\s+/g, " ").slice(0, 240);
              if (isError) {
                rec.errorCategory = classifyError(out);
                trace.failures++;
              }
            }
          }
        }
        continue;
      }
      // A typed user prompt (string content) or an interruption signal.
      const txt = blockText(content).trim();
      if (!txt) continue;
      if (txt.startsWith(INTERRUPT_MARKER)) {
        trace.events.push({ type: "user", turn: { kind: "interruption", text: txt.slice(0, 200) } });
        trace.interruptions++;
      } else {
        trace.events.push({ type: "user", turn: { kind: "prompt", text: redactSecrets(txt).slice(0, 300) } });
      }
    }
  }
  return trace;
}

/**
 * Discover and parse transcripts for a project root.
 * Returns an empty array (not an error) when no transcripts exist, so callers
 * can decide whether that is worth surfacing.
 */
export function collectTraces(root: string, opts: { limit?: number } = {}): SessionTrace[] {
  const dir = claudeTranscriptDir(root);
  if (!dir) return [];
  return listTranscripts(dir, opts.limit).map(parseTranscript);
}
