import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMarkedBlock } from "../core/markers.js";
import { classifyError, looksLikeError } from "./classify.js";
import { buildDigest } from "./digest.js";
import { claudeTranscriptDir, listTranscripts, parseTranscript } from "./transcripts.js";
import type { LearnAnalysis } from "./types.js";
import { LEARN_MARKER_ID, renderLearnBlock, writeLearnResults } from "./writer.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-learn-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Write a transcript line for the Claude Code JSONL format. */
function toolUse(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
}
function toolResult(id: string, content: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
  });
}
function userPrompt(text: string): string {
  return JSON.stringify({ type: "user", message: { content: text } });
}

describe("classifyError", () => {
  it("maps known signatures to categories", () => {
    expect(classifyError("Error: ENOENT: no such file or directory")).toBe("file_not_found");
    expect(classifyError("Cannot find module 'foo'")).toBe("module_not_found");
    expect(classifyError("zsh: command not found: harness")).toBe("command_not_found");
    expect(classifyError("permission denied")).toBe("permission_denied");
    expect(classifyError("error TS2345: type 'x' is not assignable")).toBe("type_error");
    expect(classifyError("3 failed | 10 passed")).toBe("test_failure");
  });
  it("falls back to non_zero_exit / other", () => {
    expect(classifyError("process exited with exit code 2")).toBe("non_zero_exit");
    expect(classifyError("something weird happened")).toBe("other");
  });
  it("looksLikeError detects unflagged errors", () => {
    expect(looksLikeError("Traceback (most recent call last):")).toBe(true);
    expect(looksLikeError("all good, 2 files written")).toBe(false);
  });
});

describe("parseTranscript", () => {
  it("normalizes tool calls, failures, and user turns", () => {
    const file = path.join(root, "abc.jsonl");
    fs.writeFileSync(
      file,
      [
        userPrompt("please fix the build"),
        toolUse("t1", "Bash", { command: "node dist/cli.js --version", description: "version" }),
        toolResult("t1", "0.1.0"),
        toolUse("t2", "Bash", { command: "harness gate run" }),
        toolResult("t2", "zsh: command not found: harness", true),
        JSON.stringify({ type: "user", message: { content: "[Request interrupted by user]" } }),
      ].join("\n") + "\n",
    );
    const trace = parseTranscript(file);
    expect(trace.id).toBe("abc");
    expect(trace.toolCalls).toBe(2);
    expect(trace.failures).toBe(1);
    expect(trace.interruptions).toBe(1);
    const failed = trace.events.find((e) => e.type === "tool" && e.tool.isError);
    expect(failed?.type === "tool" && failed.tool.errorCategory).toBe("command_not_found");
  });

  it("flags unflagged-but-erroring output via heuristic", () => {
    const file = path.join(root, "x.jsonl");
    fs.writeFileSync(
      file,
      [toolUse("a", "Bash", { command: "build" }), toolResult("a", "Error: build failed\nTraceback...", false)].join(
        "\n",
      ) + "\n",
    );
    const trace = parseTranscript(file);
    expect(trace.failures).toBe(1);
  });
});

describe("claudeTranscriptDir", () => {
  it("derives the escaped project dir under a fake home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
    const proj = "/Users/me/src/app";
    const escaped = proj.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = path.join(home, ".claude", "projects", escaped);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "s.jsonl"), "");
    expect(claudeTranscriptDir(proj, home)).toBe(dir);
    expect(listTranscripts(dir)).toHaveLength(1);
    fs.rmSync(home, { recursive: true, force: true });
  });
  it("returns null when no project dir exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
    expect(claudeTranscriptDir("/nope/here", home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});

describe("buildDigest", () => {
  it("prioritizes high-failure sessions and bounds by char budget", () => {
    const traces = [
      { id: "low", events: [], toolCalls: 5, failures: 0, interruptions: 0 },
      {
        id: "high",
        events: [
          { type: "tool" as const, tool: { name: "Bash", inputSummary: "x", isError: true, errorCategory: "timeout" as const, outputPreview: "timed out" } },
        ],
        toolCalls: 3,
        failures: 1,
        interruptions: 0,
      },
    ];
    const { text } = buildDigest(traces, { maxChars: 10_000 });
    expect(text.indexOf("Session high")).toBeLessThan(text.indexOf("Session low"));
    expect(text).toContain("2 sessions");
  });
});

describe("writeLearnResults", () => {
  it("writes a managed block to CLAUDE.md and round-trips via readMarkedBlock", () => {
    const analysis: LearnAnalysis = {
      contextRules: [{ section: "Environment", content: "- use node dist/cli.js, not `harness`", evidenceCount: 3 }],
      lessons: [],
    };
    const written = writeLearnResults(root, analysis, "2026-06-19");
    expect(written).toContain("CLAUDE.md");
    const block = readMarkedBlock(path.join(root, "CLAUDE.md"), LEARN_MARKER_ID);
    expect(block).toContain("### Environment");
    expect(block).toContain("node dist/cli.js");
  });

  it("renders token-savings annotation when provided", () => {
    const md = renderLearnBlock(
      { contextRules: [{ section: "Workflow", content: "- batch edits", evidenceCount: 2, estimatedTokensSaved: 1500 }], lessons: [] },
      "2026-06-19",
    );
    expect(md).toContain("1,500 tokens/session");
  });

  it("folds lessons into project profile notes when a profile exists", () => {
    const profileDir = path.join(root, ".harness");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "project_profile.json"),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: "2026-06-19T00:00:00Z",
        root,
        name: "demo",
        technologies: [],
        inferredCommands: {},
        layout: {},
        notableFiles: [],
        notes: [],
      }),
    );
    const written = writeLearnResults(root, { contextRules: [], lessons: ["prefer pnpm over npm"] }, "2026-06-19");
    expect(written).toContain(".harness/project_profile.json");
    const profile = JSON.parse(fs.readFileSync(path.join(profileDir, "project_profile.json"), "utf8"));
    expect(profile.notes).toContain("[learn] prefer pnpm over npm");
  });
});
