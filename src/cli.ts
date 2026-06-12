#!/usr/bin/env node
/**
 * harness — framework-agnostic development harness CLI.
 *
 * Conventions:
 *  - human-readable status goes to stderr (via Logger)
 *  - machine-readable results go to stdout (use --json where available)
 *  - exit code 0 = ok, 1 = check failed, 2 = usage/config error
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { analyzeProject, loadProfile, PROFILE_PATH } from "./analyze/analyzer.js";
import { CONFIG_FILENAME, ConfigError, loadConfig } from "./config/load.js";
import { generateContext, renderContextMarkdown } from "./context/generator.js";
import { fileExists, writeText } from "./core/fsutil.js";
import { Logger } from "./core/logger.js";
import { gatesPassed, runGates } from "./gates/runner.js";
import { checkCommand } from "./guardrails/commandPolicy.js";
import { checkDiff, isGitRepo } from "./guardrails/diffBudget.js";
import { DB_PATH, HarnessDb } from "./db/database.js";
import { buildBrief } from "./context/brief.js";
import { checkDocs, DOC_TYPES, generateDocs, type DocType } from "./docs/generate.js";
import { runDoctor } from "./doctor/doctor.js";
import { addClaim, listClaims, releaseAgentClaims, releaseClaim } from "./guardrails/claims.js";
import { integrateClaude, integrateCodex, integrateGitHooks } from "./integrations/install.js";
import { syncSkillAndCommands } from "./integrations/skill.js";
import { startMcpServer } from "./mcp/server.js";
import { createPlan, listPlans, loadPlan, setPlanStatus } from "./plans/plans.js";
import { buildPrSummary } from "./report/prSummary.js";
import { summarizeSession } from "./session/summarize.js";
import { buildGateReport, listReports, renderMarkdown, writeReport } from "./report/reporter.js";
import {
  appendEvent,
  endSession,
  getActiveSession,
  listSessions,
  loadEvents,
  loadSession,
  readPromptHistory,
  startSession,
  writeHandoff,
} from "./session/store.js";
import {
  createRequirement,
  lintRequirement,
  listRequirements,
  loadRequirement,
} from "./requirements/requirements.js";
import { ALL_GATE_IDS, type GateId } from "./types.js";

const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;

const program = new Command();
program
  .name("harness")
  .description("Framework-agnostic development harness: analysis, quality gates, AI guardrails, reports")
  .version("0.1.0")
  .option("-C, --cwd <dir>", "project root", process.cwd());

function ctx() {
  const root = path.resolve(program.opts<{ cwd: string }>().cwd);
  const logger = new Logger({ root });
  try {
    const { config, source } = loadConfig(root);
    if (!source) logger.debug(`${CONFIG_FILENAME} not found, using defaults`);
    return { root, config, logger };
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(err.message);
      process.exit(EXIT_USAGE);
    }
    throw err;
  }
}

function requireProfile(root: string, logger: Logger) {
  const profile = loadProfile(root);
  if (!profile) {
    logger.error(`${PROFILE_PATH} not found — run \`harness analyze\` first`);
    process.exit(EXIT_USAGE);
  }
  return profile;
}

// ---------------------------------------------------------------- init
program
  .command("init")
  .description(`create ${CONFIG_FILENAME} and .harness/ scaffolding`)
  .action(() => {
    const root = path.resolve(program.opts<{ cwd: string }>().cwd);
    const logger = new Logger({ root });
    const configPath = path.join(root, CONFIG_FILENAME);
    if (fileExists(configPath)) {
      logger.warn(`${CONFIG_FILENAME} already exists — leaving it untouched`);
    } else {
      writeText(configPath, defaultYaml(path.basename(root)));
      logger.info(`created ${CONFIG_FILENAME}`);
    }
    for (const dir of [".harness/reports", ".harness/requirements", ".harness/logs"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    const gitignore = path.join(root, ".harness", ".gitignore");
    if (!fileExists(gitignore)) {
      writeText(gitignore, "logs/\ncache/\n");
    } else {
      const current = fs.readFileSync(gitignore, "utf8");
      if (!current.includes("cache/")) writeText(gitignore, current.trimEnd() + "\ncache/\n");
    }
    logger.info("initialized .harness/ (commit reports/requirements, logs+cache are git-ignored)");
    logger.info("next: harness analyze && harness context");
    logger.info("agent setup: harness integrate claude / harness integrate codex");
  });

// ---------------------------------------------------------------- analyze
program
  .command("analyze")
  .description(`detect stack and write ${PROFILE_PATH}`)
  .option("--json", "print profile JSON to stdout")
  .action((opts: { json?: boolean }) => {
    const { root, config, logger } = ctx();
    const profile = analyzeProject(root, config, logger);
    if (opts.json) {
      process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
    } else {
      process.stdout.write(`Project: ${profile.name}\n`);
      process.stdout.write(`Technologies:\n`);
      for (const t of profile.technologies) {
        process.stdout.write(`  - ${t.name}${t.version ? ` ${t.version}` : ""} [${t.kind}]\n`);
      }
      process.stdout.write(`Inferred commands:\n`);
      for (const [g, c] of Object.entries(profile.inferredCommands)) {
        process.stdout.write(`  - ${g}: ${c}\n`);
      }
    }
  });

// ---------------------------------------------------------------- context
program
  .command("context")
  .description("generate structured context for AI agents (.harness/context.{json,md})")
  .option("--print", "print the markdown context to stdout")
  .action((opts: { print?: boolean }) => {
    const { root, config, logger } = ctx();
    // Re-analyze on the fly so context never goes stale.
    const profile = analyzeProject(root, config, logger);
    const context = generateContext(root, config, profile);
    logger.info("wrote .harness/context.json and .harness/context.md");
    if (opts.print) process.stdout.write(renderContextMarkdown(context, profile) + "\n");
  });

// ---------------------------------------------------------------- gate
const gate = program.command("gate").description("quality gates");
gate
  .command("run")
  .description("run quality gates and write a report")
  .option("--only <gates>", `comma-separated subset of: ${ALL_GATE_IDS.join(",")}`)
  .option(
    "--changed [base]",
    "scope gates to changed files (vs working tree, or vs a base ref); gates with a changedCommand template run scoped",
  )
  .option("--no-report", "skip writing a report file")
  .action(async (opts: { only?: string; changed?: string | boolean; report: boolean }) => {
    const { root, config, logger } = ctx();
    const profile = loadProfile(root) ?? analyzeProject(root, config, logger);

    let only: GateId[] | undefined;
    if (opts.only) {
      only = opts.only.split(",").map((s) => s.trim()) as GateId[];
      const bad = only.filter((g) => !ALL_GATE_IDS.includes(g));
      if (bad.length > 0) {
        logger.error(`unknown gates: ${bad.join(", ")}`);
        process.exit(EXIT_USAGE);
      }
    }

    let changedFiles: string[] | undefined;
    if (opts.changed !== undefined && opts.changed !== false) {
      if (!isGitRepo(root)) {
        logger.error("--changed requires a git repository");
        process.exit(EXIT_USAGE);
      }
      const base = typeof opts.changed === "string" ? opts.changed : undefined;
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync(
        "git",
        ["diff", "--name-only", "--diff-filter=d", ...(base ? [`${base}...HEAD`] : ["HEAD"])],
        { cwd: root, encoding: "utf8" },
      ).trim();
      changedFiles = out ? out.split("\n") : [];
      logger.info(`changed files: ${changedFiles.length}`);
    }

    const results = await runGates(root, config, profile, logger, { only, changedFiles });
    const passed = gatesPassed(results);
    const report = buildGateReport(config.project.name, results, passed);

    if (opts.report) {
      const files = writeReport(root, config, report);
      logger.info(`report: ${files.map((f) => path.relative(root, f)).join(", ")}`);
    }
    process.stdout.write(renderMarkdown(report) + "\n");
    process.exit(passed ? EXIT_OK : EXIT_CHECK_FAILED);
  });

// ---------------------------------------------------------------- guard
const guard = program.command("guard").description("AI-agent guardrails");
guard
  .command("check-command <cmd>")
  .description("evaluate a shell command against the safety policy")
  .option("--json", "print verdict JSON")
  .action((cmd: string, opts: { json?: boolean }) => {
    const { config } = ctx();
    const verdict = checkCommand(cmd, {
      extraDenied: config.agent.deniedCommands,
      allowed: config.agent.allowedCommands,
    });
    if (opts.json) process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
    else {
      process.stdout.write(`${verdict.verdict.toUpperCase()}: ${verdict.command}\n`);
      for (const r of verdict.reasons) process.stdout.write(`  - ${r}\n`);
    }
    process.exit(verdict.verdict === "deny" ? EXIT_CHECK_FAILED : EXIT_OK);
  });

guard
  .command("scan-diff")
  .description("check current diff against change budget, protected paths, claims, plan, and secrets")
  .option("--base <ref>", "compare against a base ref (CI: origin/main) instead of working tree")
  .option("--agent <name>", "agent performing the change (for claim conflicts)", "human")
  .option("--json", "print result JSON")
  .action((opts: { base?: string; agent: string; json?: boolean }) => {
    const { root, config, logger } = ctx();
    if (!isGitRepo(root)) {
      logger.error("not a git repository — guard scan-diff requires git");
      process.exit(EXIT_USAGE);
    }
    const result = checkDiff(root, config, { baseRef: opts.base, agent: opts.agent });
    if (opts.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      process.stdout.write(
        `${result.ok ? "OK" : "VIOLATIONS"}: ${result.filesChanged} files, +${result.linesAdded}/-${result.linesDeleted}\n`,
      );
      for (const v of result.violations) process.stdout.write(`  - ${v}\n`);
    }
    process.exit(result.ok ? EXIT_OK : EXIT_CHECK_FAILED);
  });

// ---------------------------------------------------------------- req
const req = program.command("req").description("requirement management");
req
  .command("new <title>")
  .description("create a structured requirement skeleton (.harness/requirements/)")
  .action((title: string) => {
    const { root, logger } = ctx();
    const { req: created, file } = createRequirement(root, title);
    logger.info(`created ${path.relative(root, file)}`);
    process.stdout.write(
      `${created.id} created. Fill in summary/userStories/acceptanceCriteria/nonFunctional, then run:\n` +
        `  harness req lint ${created.id}\n`,
    );
  });

req
  .command("lint <idOrFile>")
  .description("detect ambiguous wording and missing criteria in a requirement")
  .action((idOrFile: string) => {
    const { root, logger } = ctx();
    const loaded = loadRequirement(root, idOrFile);
    if (!loaded) {
      logger.error(`requirement not found: ${idOrFile}`);
      process.exit(EXIT_USAGE);
    }
    const findings = lintRequirement(loaded.req);
    if (findings.length === 0) {
      process.stdout.write(`${loaded.req.id}: no issues found\n`);
      process.exit(EXIT_OK);
    }
    for (const f of findings) {
      process.stdout.write(`${f.severity === "error" ? "✖" : "⚠"} ${f.message}\n`);
    }
    process.exit(findings.some((f) => f.severity === "error") ? EXIT_CHECK_FAILED : EXIT_OK);
  });

req
  .command("list")
  .description("list requirements")
  .action(() => {
    const { root } = ctx();
    for (const r of listRequirements(root)) {
      process.stdout.write(`${r.id}  [${r.status}]  ${r.title}  (${r.file})\n`);
    }
  });

// ---------------------------------------------------------------- claim
const claim = program.command("claim").description("exclusive work claims (concurrent-agent conflict prevention)");

claim
  .command("add <path>")
  .description("claim a file or directory so other agents don't touch it")
  .option("--agent <name>", "claiming agent", "human")
  .option("--reason <text>", "why this claim exists")
  .action((claimPath: string, opts: { agent: string; reason?: string }) => {
    const { root, logger } = ctx();
    try {
      const c = addClaim(root, claimPath, opts.agent, opts.reason);
      process.stdout.write(`claimed ${c.path} for ${c.agent}\n`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

claim
  .command("release <path>")
  .description("release a claim you hold")
  .option("--agent <name>", "agent releasing", "human")
  .action((claimPath: string, opts: { agent: string }) => {
    const { root, logger } = ctx();
    try {
      releaseClaim(root, claimPath, opts.agent);
      process.stdout.write(`released ${claimPath}\n`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

claim
  .command("release-all")
  .description("release every claim held by an agent")
  .requiredOption("--agent <name>", "agent whose claims to release")
  .action((opts: { agent: string }) => {
    const { root } = ctx();
    const n = releaseAgentClaims(root, opts.agent);
    process.stdout.write(`released ${n} claim(s) held by ${opts.agent}\n`);
  });

claim
  .command("list")
  .description("list active claims")
  .action(() => {
    const { root } = ctx();
    for (const c of listClaims(root)) {
      process.stdout.write(
        `${c.path}  (${c.agent}${c.sessionId ? `, ${c.sessionId}` : ""}, since ${c.claimedAt})${c.reason ? `  — ${c.reason}` : ""}\n`,
      );
    }
  });

// ---------------------------------------------------------------- plan
const plan = program.command("plan").description("implementation plans (.harness/plans/) — humans approve before agents change code");

plan
  .command("new <title>")
  .description("create a draft plan")
  .option("--req <id>", "linked requirement id (REQ-xxx)")
  .option("--step <step...>", "plan steps (repeatable)")
  .action((title: string, opts: { req?: string; step?: string[] }) => {
    const { root } = ctx();
    const { plan: created, file } = createPlan(root, title, {
      requirement: opts.req,
      steps: opts.step,
    });
    process.stdout.write(`${created.id} created (${path.relative(root, file)}). Approve with: harness plan approve ${created.id}\n`);
  });

for (const [status, desc] of [
  ["approved", "approve a plan (human sign-off)"],
  ["rejected", "reject a plan"],
  ["completed", "mark an approved plan as completed"],
] as const) {
  plan
    .command(`${status === "approved" ? "approve" : status === "rejected" ? "reject" : "complete"} <id>`)
    .description(desc)
    .option("--by <name>", "who is approving")
    .action((id: string, opts: { by?: string }) => {
      const { root, logger } = ctx();
      try {
        const updated = setPlanStatus(root, id, status, opts.by);
        process.stdout.write(`${updated.id} is now ${updated.status}\n`);
      } catch (err) {
        logger.error((err as Error).message);
        process.exit(EXIT_CHECK_FAILED);
      }
    });
}

plan
  .command("list")
  .description("list plans")
  .action(() => {
    const { root } = ctx();
    for (const p of listPlans(root)) {
      process.stdout.write(`${p.id}  [${p.status}]  ${p.title}${p.requirement ? `  (${p.requirement})` : ""}\n`);
    }
  });

plan
  .command("show <id>")
  .description("show a plan")
  .action((id: string) => {
    const { root, logger } = ctx();
    const p = loadPlan(root, id);
    if (!p) {
      logger.error(`plan not found: ${id}`);
      process.exit(EXIT_USAGE);
    }
    process.stdout.write(JSON.stringify(p, null, 2) + "\n");
  });

// ---------------------------------------------------------------- session
const session = program.command("session").description("shared agent sessions (Claude/Codex) and prompt history");

session
  .command("start <title>")
  .description("start a new shared session")
  .option("--agent <name>", "agent recording the event (claude|codex|human|...)", "human")
  .action((title: string, opts: { agent: string }) => {
    const { root, logger } = ctx();
    try {
      const s = startSession(root, title, opts.agent);
      logger.info(`session ${s.id} started`);
      process.stdout.write(`${s.id} "${s.title}" active. Other agents join automatically.\n`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

session
  .command("prompt [text]")
  .description("record a prompt (kept in .harness/prompt_history.jsonl by default)")
  .option("--agent <name>", "agent name", "human")
  .option("--stdin", "read prompt text from stdin")
  .option("--from-claude-hook", "parse Claude Code UserPromptSubmit hook JSON from stdin (always exits 0)")
  .action(async (text: string | undefined, opts: { agent: string; stdin?: boolean; fromClaudeHook?: boolean }) => {
    if (opts.fromClaudeHook) {
      // Hook mode must never fail the user's prompt and must not write to
      // stdout (UserPromptSubmit stdout becomes extra prompt context).
      try {
        const root = path.resolve(program.opts<{ cwd: string }>().cwd);
        const raw = await readStdin();
        const prompt = (JSON.parse(raw) as { prompt?: unknown }).prompt;
        if (typeof prompt === "string" && prompt.trim()) {
          const { config } = loadConfig(root);
          if (config.session.promptHistory) {
            appendEvent(root, "prompt", prompt, "claude");
          }
        }
      } catch {
        // swallow everything in hook mode
      }
      process.exit(EXIT_OK);
    }

    const { root, config, logger } = ctx();
    const body = opts.stdin ? await readStdin() : text;
    if (!body?.trim()) {
      logger.error("prompt text required (argument or --stdin)");
      process.exit(EXIT_USAGE);
    }
    const result = appendEvent(root, "prompt", body, opts.agent, {
      promptHistory: config.session.promptHistory,
    });
    logger.info(
      result.sessionId
        ? `recorded in session ${result.sessionId} and prompt history`
        : "no active session — recorded in prompt history only",
    );
  });

for (const kind of ["note", "decision"] as const) {
  session
    .command(`${kind} <text>`)
    .description(`record a ${kind} in the active session`)
    .option("--agent <name>", "agent name", "human")
    .action((text: string, opts: { agent: string }) => {
      const { root, logger } = ctx();
      const result = appendEvent(root, kind, text, opts.agent);
      if (!result.sessionId) {
        logger.error("no active session — run `harness session start` first");
        process.exit(EXIT_CHECK_FAILED);
      }
      logger.info(`${kind} recorded in ${result.sessionId}`);
    });
}

session
  .command("cost")
  .description("record token/cost usage for the active session (shows up in team activity)")
  .option("--usd <amount>", "cost in USD")
  .option("--tokens-in <n>", "input tokens")
  .option("--tokens-out <n>", "output tokens")
  .option("--note <text>", "what the cost was for")
  .option("--agent <name>", "agent name", "human")
  .action((opts: { usd?: string; tokensIn?: string; tokensOut?: string; note?: string; agent: string }) => {
    const { root, logger } = ctx();
    const data: Record<string, number> = {};
    if (opts.usd) data.usd = Number.parseFloat(opts.usd);
    if (opts.tokensIn) data.tokensIn = Number.parseInt(opts.tokensIn, 10);
    if (opts.tokensOut) data.tokensOut = Number.parseInt(opts.tokensOut, 10);
    if (Object.keys(data).length === 0 || Object.values(data).some((v) => Number.isNaN(v))) {
      logger.error("provide at least one numeric value: --usd, --tokens-in, --tokens-out");
      process.exit(EXIT_USAGE);
    }
    const result = appendEvent(root, "cost", opts.note ?? "cost recorded", opts.agent, { data });
    if (!result.sessionId) {
      logger.error("no active session — run `harness session start` first");
      process.exit(EXIT_CHECK_FAILED);
    }
    logger.info(`cost recorded in ${result.sessionId}`);
  });

session
  .command("summarize [id]")
  .description("summarize a session with an LLM and fold lessons into the project profile (defaults to active/latest session)")
  .option("--agent <name>", "agent name", "human")
  .action(async (id: string | undefined, opts: { agent: string }) => {
    const { root, config, logger } = ctx();
    try {
      const { session: s, file, summary } = await summarizeSession(root, config, opts.agent, id);
      logger.info(`summary written to ${path.relative(root, file)}`);
      process.stdout.write(`# ${s.title} (${s.id})\n\n${summary.trim()}\n`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

session
  .command("handoff")
  .description("write a handoff document so the next agent (Claude/Codex) can continue")
  .option("--agent <name>", "agent name", "human")
  .action((opts: { agent: string }) => {
    const { root, config, logger } = ctx();
    try {
      const latest = listReports(root, config).filter((f) => f.endsWith(".md")).pop();
      const file = writeHandoff(root, opts.agent, latest);
      logger.info(`handoff written`);
      process.stdout.write(path.relative(root, file) + "\n");
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

session
  .command("end")
  .description("close the active session")
  .option("--agent <name>", "agent name", "human")
  .action((opts: { agent: string }) => {
    const { root, logger } = ctx();
    try {
      const s = endSession(root, opts.agent);
      process.stdout.write(`${s.id} closed (agents: ${s.agents.join(", ")})\n`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

session
  .command("list")
  .description("list sessions")
  .action(() => {
    const { root } = ctx();
    for (const s of listSessions(root)) {
      process.stdout.write(`${s.id}  [${s.status}]  ${s.title}  (agents: ${s.agents.join(", ")})\n`);
    }
  });

session
  .command("show [id]")
  .description("show a session and its events (defaults to the active session)")
  .option("--json", "print JSON")
  .action((id: string | undefined, opts: { json?: boolean }) => {
    const { root, logger } = ctx();
    const s = id ? loadSession(root, id) : getActiveSession(root);
    if (!s) {
      logger.error(id ? `session not found: ${id}` : "no active session");
      process.exit(EXIT_USAGE);
    }
    const events = loadEvents(root, s.id);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ...s, events }, null, 2) + "\n");
      return;
    }
    process.stdout.write(`${s.id} "${s.title}" [${s.status}] agents: ${s.agents.join(", ")}\n`);
    for (const e of events) {
      process.stdout.write(`  [${e.ts}] ${e.agent} ${e.kind}: ${e.text}\n`);
    }
  });

// ---------------------------------------------------------------- history
program
  .command("history")
  .description("show prompt history (.harness/prompt_history.jsonl)")
  .option("--limit <n>", "max entries", "50")
  .option("--search <query>", "substring search via the SQLite index")
  .option("--agent <name>", "filter search results to one agent (with --search)")
  .option("--json", "print JSON")
  .action(async (opts: { limit: string; search?: string; agent?: string; json?: boolean }) => {
    const { root } = ctx();
    const limit = Number.parseInt(opts.limit, 10) || 50;

    if (opts.search) {
      const db = await HarnessDb.open(root);
      try {
        db.reindex();
        const hits = db.searchPrompts(opts.search, limit, opts.agent);
        if (opts.json) {
          process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
          return;
        }
        for (const h of hits) {
          process.stdout.write(`[${h.ts}] ${h.agent}${h.sessionId ? ` (${h.sessionId})` : ""}: ${h.text}\n`);
        }
      } finally {
        db.close();
      }
      return;
    }

    const entries = readPromptHistory(root, limit);
    if (opts.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }
    for (const e of entries) {
      process.stdout.write(`[${e.ts}] ${e.agent}${e.sessionId ? ` (${e.sessionId})` : ""}: ${e.text}\n`);
    }
  });

// ---------------------------------------------------------------- team (= the team of agents)
const team = program
  .command("team")
  .description("the team of agents: per-agent sessions and activity (SQLite-backed)");

function renderTable(header: string[], data: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => d[i]!.length)));
  const fmt = (cols: string[]) => cols.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [fmt(header), ...data.map(fmt)].join("\n") + "\n";
}

team
  .command("list")
  .description("list agents observed in sessions and prompt history")
  .action(async () => {
    const { root } = ctx();
    const db = await HarnessDb.open(root);
    try {
      db.reindex();
      for (const agent of db.listAgents()) process.stdout.write(agent + "\n");
    } finally {
      db.close();
    }
  });

team
  .command("activity")
  .description("per-agent activity: sessions, prompts, decisions, last active")
  .option("--agent <name>", "filter to one agent")
  .option("--json", "print JSON")
  .action(async (opts: { agent?: string; json?: boolean }) => {
    const { root } = ctx();
    const db = await HarnessDb.open(root);
    try {
      db.reindex();
      let rows = db.agentActivity();
      if (opts.agent) rows = rows.filter((r) => r.agent === opts.agent);
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        renderTable(
          ["agent", "sessions", "prompts", "decisions", "notes", "tokens", "usd", "last active"],
          rows.map((r) => [
            r.agent,
            String(r.sessions),
            String(r.prompts),
            String(r.decisions),
            String(r.notes),
            String(r.tokens),
            r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : "-",
            r.lastActive ?? "-",
          ]),
        ),
      );
    } finally {
      db.close();
    }
  });

team
  .command("sessions <agent>")
  .description("sessions the agent participated in, with its event footprint")
  .option("--json", "print JSON")
  .action(async (agent: string, opts: { json?: boolean }) => {
    const { root } = ctx();
    const db = await HarnessDb.open(root);
    try {
      db.reindex();
      const rows = db.agentSessions(agent);
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
        return;
      }
      process.stdout.write(
        renderTable(
          ["session", "status", "title", "events", "last event"],
          rows.map((r) => [r.id, r.status, r.title, String(r.events), r.lastEventAt ?? "-"]),
        ),
      );
    } finally {
      db.close();
    }
  });

// ---------------------------------------------------------------- reindex
program
  .command("reindex")
  .description(`rebuild the SQLite query index (${DB_PATH}) from the files of record`)
  .action(async () => {
    const { root, logger } = ctx();
    const db = await HarnessDb.open(root);
    try {
      const counts = db.reindex();
      logger.info(
        `reindexed: ${counts.sessions} sessions, ${counts.events} events, ${counts.prompts} prompts`,
      );
    } finally {
      db.close();
    }
  });

// ---------------------------------------------------------------- integrate
program
  .command("integrate <target>")
  .description("install integration: claude (prompt hook + CLAUDE.md), codex (AGENTS.md), git-hooks (pre-commit/pre-push)")
  .action((target: string) => {
    const { root, logger } = ctx();
    let changes: string[];
    try {
      if (target === "claude") changes = integrateClaude(root);
      else if (target === "codex") changes = integrateCodex(root);
      else if (target === "git-hooks") changes = integrateGitHooks(root);
      else {
        logger.error(`unknown target "${target}" — supported: claude, codex, git-hooks`);
        process.exit(EXIT_USAGE);
        return;
      }
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
      return;
    }
    if (changes.length === 0) process.stdout.write("already integrated — nothing to do\n");
    for (const c of changes) process.stdout.write(`+ ${c}\n`);
  });

// ---------------------------------------------------------------- doctor
program
  .command("doctor")
  .description("diagnose the environment: node, sqlite, git, config, profile, gates, claims, integrations")
  .option("--json", "print JSON")
  .action(async (opts: { json?: boolean }) => {
    const root = path.resolve(program.opts<{ cwd: string }>().cwd);
    const checks = await runDoctor(root);
    if (opts.json) {
      process.stdout.write(JSON.stringify(checks, null, 2) + "\n");
    } else {
      for (const c of checks) {
        const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" }[c.status];
        process.stdout.write(`${icon} ${c.name.padEnd(20)} ${c.detail}\n`);
      }
    }
    process.exit(checks.some((c) => c.status === "fail") ? EXIT_CHECK_FAILED : EXIT_OK);
  });

// ---------------------------------------------------------------- pr-summary
program
  .command("pr-summary")
  .description("generate a PR description from session decisions, diff stats, and the latest gate report")
  .option("--base <ref>", "base ref to diff against (e.g. origin/main)")
  .option("--out <file>", "also write to a file (for gh pr create --body-file)")
  .action((opts: { base?: string; out?: string }) => {
    const { root, config, logger } = ctx();
    const summary = buildPrSummary(root, config, opts.base);
    if (opts.out) {
      writeText(path.resolve(root, opts.out), summary);
      logger.info(`written to ${opts.out}`);
    }
    process.stdout.write(summary);
  });

// ---------------------------------------------------------------- brief
program
  .command("brief [task...]")
  .description("compose a complete kickoff prompt (requirement + plan + commands + guardrails + done criteria) for an agent")
  .option("--req <id>", "embed a requirement (REQ-xxx)")
  .option("--plan <id>", "embed a plan (PLAN-xxx; default: latest approved)")
  .option("--out <file>", "also write to a file")
  .action((task: string[], opts: { req?: string; plan?: string; out?: string }) => {
    const { root, config, logger } = ctx();
    const profile = loadProfile(root) ?? analyzeProject(root, config, logger);
    try {
      const brief = buildBrief(root, config, profile, {
        task: task.length > 0 ? task.join(" ") : undefined,
        requirementId: opts.req,
        planId: opts.plan,
      });
      if (opts.out) {
        writeText(path.resolve(root, opts.out), brief);
        logger.info(`written to ${opts.out}`);
      }
      process.stdout.write(brief);
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_USAGE);
    }
  });

// ---------------------------------------------------------------- skill
const skill = program.command("skill").description("Claude Code skill / slash-command sync");

skill
  .command("sync")
  .description("generate/update .claude/skills/dev-harness/SKILL.md and .claude/commands/harness-*.md from project knowledge")
  .action(() => {
    const { root, config, logger } = ctx();
    const profile = analyzeProject(root, config, logger);
    const results = syncSkillAndCommands(root, profile, config);
    for (const r of results) {
      process.stdout.write(`${r.changed ? "✏️  updated " : "=  unchanged"} ${r.file}\n`);
    }
  });

// ---------------------------------------------------------------- docs
const docs = program.command("docs").description("documentation generation for under-documented services");

docs
  .command("generate")
  .description(`generate docs with an LLM (${DOC_TYPES.join(", ")}); never overwrites human-written files`)
  .option("--only <types>", `comma-separated subset of: ${DOC_TYPES.join(",")}`)
  .option("--force", "regenerate docs that were previously generated by the harness")
  .action(async (opts: { only?: string; force?: boolean }) => {
    const { root, config, logger } = ctx();
    let only: DocType[] | undefined;
    if (opts.only) {
      only = opts.only.split(",").map((s) => s.trim()) as DocType[];
      const bad = only.filter((t) => !DOC_TYPES.includes(t));
      if (bad.length > 0) {
        logger.error(`unknown doc types: ${bad.join(", ")}`);
        process.exit(EXIT_USAGE);
      }
    }
    const profile = loadProfile(root) ?? analyzeProject(root, config, logger);
    try {
      const results = await generateDocs(root, config, profile, { only, force: opts.force });
      for (const r of results) {
        const label = {
          written: "✏️  written",
          "skipped-exists": "=  exists (use --force to regenerate)",
          "skipped-human-file": "🔒 human-written, not touched",
        }[r.action];
        process.stdout.write(`${label}  ${r.file}\n`);
      }
      process.stdout.write("Review the generated docs before committing — they are drafts.\n");
    } catch (err) {
      logger.error((err as Error).message);
      process.exit(EXIT_CHECK_FAILED);
    }
  });

docs
  .command("check")
  .description("detect missing or stale docs (vs newest source mtime)")
  .option("--strict", "exit 1 when anything is missing or stale (for CI)")
  .option("--json", "print JSON")
  .action((opts: { strict?: boolean; json?: boolean }) => {
    const { root } = ctx();
    const findings = checkDocs(root);
    if (opts.json) {
      process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    } else {
      for (const f of findings) {
        const icon = { ok: "✅", stale: "⚠️ ", missing: "❌" }[f.status];
        process.stdout.write(`${icon} ${f.file.padEnd(24)} ${f.detail}\n`);
      }
    }
    const bad = findings.some((f) => f.status !== "ok");
    process.exit(opts.strict && bad ? EXIT_CHECK_FAILED : EXIT_OK);
  });

// ---------------------------------------------------------------- mcp
program
  .command("mcp")
  .description("run the harness as an MCP server over stdio (register in Claude Code / Codex)")
  .action(async () => {
    const { root, config } = ctx();
    await startMcpServer(root, config);
    // Keep the process alive; the transport owns stdin/stdout from here.
  });

// ---------------------------------------------------------------- report
const reportCmd = program.command("report").description("run reports");
reportCmd
  .command("list")
  .description("list generated reports")
  .action(() => {
    const { root, config } = ctx();
    for (const f of listReports(root, config)) process.stdout.write(f + "\n");
  });

// ---------------------------------------------------------------- helpers
function defaultYaml(name: string): string {
  return `# Development harness configuration — https://github.com/peakcode/dev-harness
version: 1

project:
  name: ${name}
  # description: One line about what this service does

# Manual stack hints (merged with auto-detection): node, python, go, rails, ...
stacks: []

agent:
  requirePlan: true
  enforcePlan: false   # true = guard scan-diff fails without an approved plan (.harness/plans/)
  changeBudget:
    maxFiles: 20
    maxLinesAdded: 800
    maxLinesDeleted: 400
  protectedPaths:
    - .github/
    - infra/
  deniedCommands: []   # extra regexes, e.g. 'kubectl .* --context prod'
  allowedCommands: []  # exact/regex allowlist that bypasses the policy

llm:                   # used by "harness session summarize" / "harness docs generate"
  provider: auto       # auto = API key if set, else local Claude Code session (claude -p)
  # model: claude-opus-4-8
  apiKeyEnv: ANTHROPIC_API_KEY
  maxTokens: 2048

# Each gate: command (overrides auto-detection; null disables), required, timeoutSec
gates: {}
#  test:
#    command: npm test -- --ci
#    required: true
#    timeoutSec: 900
#  coverage:
#    command: npx vitest run --coverage
#    threshold: 80
#    required: false

session:
  promptHistory: true  # record prompts to .harness/prompt_history.jsonl (default on)
  contextEvents: 20    # recent session events embedded in agent context

context:
  includeFiles: []
  rules: []            # extra project rules surfaced to AI agents

report:
  dir: .harness/reports
  formats: [md, json]
`;
}

program.parseAsync(process.argv).catch((err: unknown) => {
  process.stderr.write(`✖ ${(err as Error).message}\n`);
  process.exit(EXIT_USAGE);
});
