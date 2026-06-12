/**
 * MCP server: exposes the harness to AI agents as native tools over stdio.
 * Claude Code / Codex register this with `harness mcp` as the command, and
 * then call get_context / run_gates / record_event etc. as tool invocations
 * instead of shelling out and parsing CLI output.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzeProject } from "../analyze/analyzer.js";
import type { HarnessConfig } from "../config/schema.js";
import { generateContext, renderContextMarkdown } from "../context/generator.js";
import { Logger } from "../core/logger.js";
import { HarnessDb } from "../db/database.js";
import { gatesPassed, runGates } from "../gates/runner.js";
import { addClaim, listClaims, releaseClaim } from "../guardrails/claims.js";
import { checkCommand } from "../guardrails/commandPolicy.js";
import { checkDiff, isGitRepo } from "../guardrails/diffBudget.js";
import { buildGateReport, renderMarkdown, writeReport } from "../report/reporter.js";
import { appendEvent, writeHandoff } from "../session/store.js";
import { ALL_GATE_IDS, type GateId } from "../types.js";

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function errorText(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
}

export async function startMcpServer(root: string, config: HarnessConfig): Promise<void> {
  // Logger writes to stderr only — stdout is reserved for the MCP transport.
  const logger = new Logger({ root, level: "error" });
  const server = new McpServer({ name: "dev-harness", version: "0.1.0" });

  server.tool(
    "get_context",
    "Get structured project context: stack, layout, commands, guardrails, active shared session. Call this before starting work.",
    {},
    async () => {
      try {
        const profile = analyzeProject(root, config, logger);
        const context = generateContext(root, config, profile);
        return text(renderContextMarkdown(context, profile));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "run_gates",
    "Run quality gates (lint/typecheck/test/build/...) and return the report. Run after making changes.",
    {
      only: z.array(z.enum(ALL_GATE_IDS as [GateId, ...GateId[]])).optional()
        .describe("Subset of gates to run; omit for all"),
    },
    async ({ only }) => {
      try {
        const profile = analyzeProject(root, config, logger);
        const results = await runGates(root, config, profile, logger, { only });
        const report = buildGateReport(config.project.name, results, gatesPassed(results));
        writeReport(root, config, report);
        return text(renderMarkdown(report));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "check_command",
    "Check a shell command against the safety policy BEFORE running it. Returns allow / confirm / deny.",
    { command: z.string().describe("The shell command to evaluate") },
    async ({ command }) => {
      const verdict = checkCommand(command, {
        extraDenied: config.agent.deniedCommands,
        allowed: config.agent.allowedCommands,
      });
      return text(verdict);
    },
  );

  server.tool(
    "scan_diff",
    "Check the current git diff against change budget, protected paths, other agents' claims, and secret introduction.",
    {
      agent: z.string().default("claude").describe("Agent performing the change"),
      base: z.string().optional().describe("Base ref to diff against (default: working tree vs HEAD)"),
    },
    async ({ agent, base }) => {
      try {
        if (!isGitRepo(root)) return errorText(new Error("not a git repository"));
        return text(checkDiff(root, config, { baseRef: base, agent }));
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "record_event",
    "Record a prompt, note, or decision in the shared agent session (and prompt history for prompts).",
    {
      kind: z.enum(["prompt", "note", "decision"]),
      text: z.string().min(1),
      agent: z.string().default("claude"),
    },
    async ({ kind, text: body, agent }) => {
      const result = appendEvent(root, kind, body, agent, {
        promptHistory: config.session.promptHistory,
      });
      return text({ recorded: true, sessionId: result.sessionId });
    },
  );

  server.tool(
    "search_history",
    "Search prompt history by substring (SQLite-backed, CJK-friendly).",
    {
      query: z.string().min(1),
      agent: z.string().optional().describe("Filter to one agent"),
      limit: z.number().int().positive().max(200).default(50),
    },
    async ({ query, agent, limit }) => {
      const db = await HarnessDb.open(root);
      try {
        db.reindex();
        return text(db.searchPrompts(query, limit, agent));
      } catch (err) {
        return errorText(err);
      } finally {
        db.close();
      }
    },
  );

  server.tool(
    "team_activity",
    "Per-agent activity across sessions: sessions, prompts, decisions, cost, last active.",
    {},
    async () => {
      const db = await HarnessDb.open(root);
      try {
        db.reindex();
        return text(db.agentActivity());
      } catch (err) {
        return errorText(err);
      } finally {
        db.close();
      }
    },
  );

  server.tool(
    "claim_paths",
    "Manage exclusive work claims so concurrent agents don't edit the same files. Claim before editing a shared area; release when done.",
    {
      action: z.enum(["add", "release", "list"]),
      path: z.string().optional().describe("Repo-relative file or directory (required for add/release)"),
      agent: z.string().default("claude"),
      reason: z.string().optional(),
    },
    async ({ action, path: claimPath, agent, reason }) => {
      try {
        if (action === "list") return text(listClaims(root));
        if (!claimPath) return errorText(new Error(`path is required for ${action}`));
        if (action === "add") return text(addClaim(root, claimPath, agent, reason));
        releaseClaim(root, claimPath, agent);
        return text({ released: claimPath });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  server.tool(
    "write_handoff",
    "Write a handoff document so the next agent (Claude/Codex) can continue the active session. Call before stopping work.",
    { agent: z.string().default("claude") },
    async ({ agent }) => {
      try {
        const file = writeHandoff(root, agent);
        return text({ handoff: file });
      } catch (err) {
        return errorText(err);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
