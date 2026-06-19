/**
 * Structured context generator for AI agents.
 * Produces .harness/context.json (machine) and .harness/context.md (prompt-ready).
 * The markdown is intentionally compact: it is meant to be prepended to an
 * agent's system/working prompt, not to replace reading the code.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { writeJson, writeText } from "../core/fsutil.js";
import { getActiveSession, loadEvents, PROMPT_HISTORY_PATH } from "../session/store.js";
import type { AgentContext, ProjectProfile } from "../types.js";
import { tuningRules } from "./tuning.js";

const BASE_RULES = [
  "Present a plan and get approval before making changes (requirePlan).",
  "Stay within the change budget; split larger work into separate reviewed steps.",
  "Never modify protected paths without explicit human sign-off.",
  "Run `harness guard check-command \"<cmd>\"` before any risky shell command.",
  "Run `harness gate run` after changes and include results in your summary.",
  "Never print or commit secrets/credentials; use placeholders and .env files.",
  "After changes, produce a diff summary: files touched, why, and risks.",
];

function gitInfo(root: string): AgentContext["git"] {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean).length;
    return { branch, dirtyFiles: dirty };
  } catch {
    return undefined;
  }
}

export function generateContext(
  root: string,
  config: HarnessConfig,
  profile: ProjectProfile,
): AgentContext {
  const commands = { ...profile.inferredCommands };
  for (const [id, gate] of Object.entries(config.gates)) {
    if (gate?.command) commands[id as keyof typeof commands] = gate.command;
    if (gate?.command === null) delete commands[id as keyof typeof commands];
  }

  const context: AgentContext = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    project: {
      name: config.project.name,
      root,
      technologies: profile.technologies,
      layout: profile.layout,
      notableFiles: profile.notableFiles,
    },
    commands,
    guardrails: {
      changeBudget: config.agent.changeBudget,
      protectedPaths: config.agent.protectedPaths,
      requirePlan: config.agent.requirePlan,
      rules: [...BASE_RULES, ...config.context.rules],
    },
    git: gitInfo(root),
  };

  const tuning = tuningRules(config);
  if (tuning) context.tuning = tuning;

  const session = getActiveSession(root);
  if (session) {
    context.session = {
      id: session.id,
      title: session.title,
      agents: session.agents,
      recentEvents: loadEvents(root, session.id).slice(-config.session.contextEvents),
    };
  }

  writeJson(path.join(root, ".harness", "context.json"), context);
  writeText(path.join(root, ".harness", "context.md"), renderContextMarkdown(context, profile));
  return context;
}

export function renderContextMarkdown(ctx: AgentContext, profile: ProjectProfile): string {
  const lines: string[] = [];
  lines.push(`# Project context: ${ctx.project.name}`);
  lines.push("");
  // The generation timestamp lives in the footer, not here: a volatile token
  // near the top would invalidate the provider's KV-cache prefix for the whole
  // (otherwise stable) document. Volatile sections (git, session, footer) stay
  // at the end so the stable prefix is as long as possible. See cache/aligner.
  lines.push("## Technology stack");
  for (const t of ctx.project.technologies) {
    const ver = t.version ? ` ${t.version}` : "";
    lines.push(`- **${t.name}**${ver} (${t.kind}, confidence ${t.confidence}) — evidence: ${t.evidence.join(", ")}`);
  }
  lines.push("");

  if (Object.keys(ctx.project.layout).length > 0) {
    lines.push("## Layout");
    for (const [dir, desc] of Object.entries(ctx.project.layout)) {
      lines.push(`- \`${dir}\`${desc ? ` — ${desc}` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Commands");
  const entries = Object.entries(ctx.commands);
  if (entries.length === 0) lines.push("- (none inferred — configure gates in harness.yaml)");
  for (const [gate, cmd] of entries) lines.push(`- ${gate}: \`${cmd}\``);
  lines.push("");

  lines.push("## Guardrails (you MUST follow these)");
  const b = ctx.guardrails.changeBudget;
  lines.push(`- Change budget: ≤${b.maxFiles} files, ≤${b.maxLinesAdded} lines added, ≤${b.maxLinesDeleted} lines deleted per change set.`);
  if (ctx.guardrails.protectedPaths.length > 0) {
    lines.push(`- Protected paths (do not modify): ${ctx.guardrails.protectedPaths.map((p) => `\`${p}\``).join(", ")}`);
  }
  for (const rule of ctx.guardrails.rules) lines.push(`- ${rule}`);
  lines.push("");

  if (ctx.tuning) {
    lines.push(`## Operating instructions (tuned for ${ctx.tuning.target})`);
    for (const rule of ctx.tuning.rules) lines.push(`- ${rule}`);
    lines.push("");
  }

  if (profile.notes.length > 0) {
    lines.push("## Project lessons");
    for (const note of profile.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  if (ctx.git) {
    lines.push("## Git");
    lines.push(`- branch: ${ctx.git.branch}, uncommitted files: ${ctx.git.dirtyFiles}`);
    lines.push("");
  }

  if (ctx.session) {
    lines.push("## Active session (shared between agents)");
    lines.push(
      `- ${ctx.session.id} "${ctx.session.title}" — agents so far: ${ctx.session.agents.join(", ")}`,
    );
    lines.push(
      `- You are joining this session. Log decisions with \`harness session decision\`; write \`harness session handoff\` before stopping. Prompt history: \`${PROMPT_HISTORY_PATH}\``,
    );
    if (ctx.session.recentEvents.length > 0) {
      lines.push("- Recent events:");
      for (const e of ctx.session.recentEvents) {
        lines.push(`  - [${e.ts}] ${e.agent} ${e.kind}: ${e.text}`);
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(`_Generated by dev-harness at ${ctx.generatedAt}. Machine-readable: .harness/context.json_`);

  return lines.join("\n");
}
