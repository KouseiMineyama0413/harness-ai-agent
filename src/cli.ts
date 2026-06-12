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
import { integrateClaude, integrateCodex } from "./integrations/install.js";
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
    if (!fileExists(gitignore)) writeText(gitignore, "logs/\n");
    logger.info("initialized .harness/ (commit reports/requirements, logs are git-ignored)");
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
  .option("--no-report", "skip writing a report file")
  .action(async (opts: { only?: string; report: boolean }) => {
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

    const results = await runGates(root, config, profile, logger, only);
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
  .description("check current diff against change budget, protected paths, and secret introduction")
  .option("--base <ref>", "compare against a base ref (CI: origin/main) instead of working tree")
  .option("--json", "print result JSON")
  .action((opts: { base?: string; json?: boolean }) => {
    const { root, config, logger } = ctx();
    if (!isGitRepo(root)) {
      logger.error("not a git repository — guard scan-diff requires git");
      process.exit(EXIT_USAGE);
    }
    const result = checkDiff(root, config, opts.base);
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
  .option("--json", "print JSON")
  .action((opts: { limit: string; json?: boolean }) => {
    const { root } = ctx();
    const entries = readPromptHistory(root, Number.parseInt(opts.limit, 10) || 50);
    if (opts.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }
    for (const e of entries) {
      process.stdout.write(`[${e.ts}] ${e.agent}${e.sessionId ? ` (${e.sessionId})` : ""}: ${e.text}\n`);
    }
  });

// ---------------------------------------------------------------- integrate
program
  .command("integrate <agent>")
  .description("install agent integration: claude (prompt hook + CLAUDE.md) or codex (AGENTS.md)")
  .action((agent: string) => {
    const { root, logger } = ctx();
    let changes: string[];
    if (agent === "claude") changes = integrateClaude(root);
    else if (agent === "codex") changes = integrateCodex(root);
    else {
      logger.error(`unknown agent "${agent}" — supported: claude, codex`);
      process.exit(EXIT_USAGE);
    }
    if (changes.length === 0) process.stdout.write("already integrated — nothing to do\n");
    for (const c of changes) process.stdout.write(`+ ${c}\n`);
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
  changeBudget:
    maxFiles: 20
    maxLinesAdded: 800
    maxLinesDeleted: 400
  protectedPaths:
    - .github/
    - infra/
  deniedCommands: []   # extra regexes, e.g. 'kubectl .* --context prod'
  allowedCommands: []  # exact/regex allowlist that bypasses the policy

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
