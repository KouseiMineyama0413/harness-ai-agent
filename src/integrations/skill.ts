/**
 * Skill & slash-command sync.
 *
 * Generates Claude Code artifacts the harness fully owns:
 *   .claude/skills/dev-harness/SKILL.md   — project knowledge as a skill
 *   .claude/commands/harness-*.md         — slash commands wrapping the CLI
 *
 * These are deterministic projections of harness.yaml + project_profile.json
 * (no LLM involved), so `harness skill sync` can run on every analyze/CI and
 * agents always see current stack, commands, guardrails, and lessons.
 */
import path from "node:path";
import { writeText } from "../core/fsutil.js";
import { generatedFileHeader } from "../core/markers.js";
import type { HarnessConfig } from "../config/schema.js";
import { tuningRules } from "../context/tuning.js";
import { readIfExists } from "../core/fsutil.js";
import type { ProjectProfile } from "../types.js";

export const SKILL_PATH = ".claude/skills/dev-harness/SKILL.md";
export const COMMANDS_DIR = ".claude/commands";

export function renderSkill(profile: ProjectProfile, config: HarnessConfig): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("name: dev-harness");
  lines.push(
    "description: " +
      `Project conventions and dev-harness workflow for ${config.project.name}. ` +
      "Use when starting any task in this repository: it lists the stack, the exact " +
      "test/build commands, guardrails you must follow, and accumulated project lessons.",
  );
  lines.push("---");
  lines.push("");
  lines.push(generatedFileHeader("harness skill sync"));
  lines.push("");
  lines.push(`# Working in ${config.project.name}`);
  lines.push("");

  lines.push("## Stack");
  for (const t of profile.technologies) {
    lines.push(`- ${t.name}${t.version ? ` ${t.version}` : ""} (${t.kind})`);
  }
  lines.push("");

  lines.push("## Commands (use these, do not guess)");
  const commands = { ...profile.inferredCommands };
  for (const [id, gate] of Object.entries(config.gates)) {
    if (gate?.command) commands[id as keyof typeof commands] = gate.command;
    if (gate?.command === null) delete commands[id as keyof typeof commands];
  }
  for (const [gate, cmd] of Object.entries(commands)) lines.push(`- ${gate}: \`${cmd}\``);
  lines.push("");

  lines.push("## Guardrails");
  const b = config.agent.changeBudget;
  lines.push(`- Change budget: ≤${b.maxFiles} files, +${b.maxLinesAdded}/-${b.maxLinesDeleted} lines per change set.`);
  if (config.agent.protectedPaths.length > 0) {
    lines.push(`- Protected paths: ${config.agent.protectedPaths.map((p) => `\`${p}\``).join(", ")}`);
  }
  if (config.agent.enforcePlan) {
    lines.push("- An approved plan is REQUIRED before changing code: `harness plan new` → human `harness plan approve`.");
  }
  for (const rule of config.context.rules) lines.push(`- ${rule}`);
  lines.push("");

  lines.push("## Workflow");
  lines.push("1. `harness context` — refresh and read project context (includes the active shared session).");
  lines.push("2. Record decisions: `harness session decision \"<text>\" --agent claude`.");
  lines.push("3. Claim shared areas before editing: `harness claim add <path> --agent claude`.");
  lines.push("4. Verify risky commands: `harness guard check-command \"<cmd>\"`.");
  lines.push("5. After changes: `harness guard scan-diff --agent claude` and `harness gate run --changed`.");
  lines.push("6. Before stopping: `harness session handoff --agent claude`.");
  lines.push("");

  const tuning = tuningRules(config);
  if (tuning) {
    lines.push(`## Operating instructions (tuned for ${tuning.target})`);
    for (const rule of tuning.rules) lines.push(`- ${rule}`);
    lines.push("");
  }

  if (profile.notes.length > 0) {
    lines.push("## Project lessons (accumulated from past sessions)");
    for (const note of profile.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return lines.join("\n");
}

interface SlashCommand {
  file: string;
  description: string;
  body: string;
}

function slashCommands(): SlashCommand[] {
  return [
    {
      file: "harness-gate.md",
      description: "dev-harness の品質ゲートを実行し、結果を要約して報告する",
      body: [
        "Run the project's quality gates with `harness gate run $ARGUMENTS` " +
          "(pass `--changed` to scope to changed files, `--only test,build` for a subset).",
        "Then summarize the result: which gates passed/failed, the failure reasons, " +
          "and the concrete next step for each required failure. The full report is in `.harness/reports/`.",
      ].join("\n"),
    },
    {
      file: "harness-handoff.md",
      description: "現在のセッションの引き継ぎドキュメントを作成して作業を終了する",
      body: [
        "Wrap up the current work session for the next agent:",
        "1. Record any unrecorded key decisions: `harness session decision \"<text>\" --agent claude`.",
        "2. Run `harness guard scan-diff --agent claude` and `harness gate run --changed`; fix or note failures.",
        "3. Release your claims: `harness claim release-all --agent claude`.",
        "4. Write the handoff: `harness session handoff --agent claude`, then show its content to the user.",
      ].join("\n"),
    },
    {
      file: "harness-plan.md",
      description: "現在のタスクの実装計画を作成し、人間の承認を求める",
      body: [
        "Create an implementation plan for: $ARGUMENTS",
        "1. Read `.harness/context.md` (refresh with `harness context` if stale).",
        "2. Decide the steps, affected files, and risks.",
        "3. Register it: `harness plan new \"<title>\" --step \"...\" --step \"...\"` (link a requirement with `--req REQ-xxx` if one exists).",
        "4. Present the plan to the user and ask them to approve with `harness plan approve <id> --by <name>`. Do NOT start changing code before approval.",
      ].join("\n"),
    },
    {
      file: "harness-pr.md",
      description: "セッションの記録から PR 説明文を生成する",
      body: [
        "Generate a pull-request description with `harness pr-summary $ARGUMENTS` " +
          "(pass `--base origin/main` on a branch).",
        "Review the output, fill in anything the harness could not know (motivation, screenshots), " +
          "and offer to create the PR with `gh pr create --body-file <(harness pr-summary --base origin/main)`.",
      ].join("\n"),
    },
  ];
}

export interface SyncResult {
  file: string;
  changed: boolean;
}

/** Write the skill and slash commands. Files are fully harness-owned. */
export function syncSkillAndCommands(
  root: string,
  profile: ProjectProfile,
  config: HarnessConfig,
): SyncResult[] {
  const results: SyncResult[] = [];

  const write = (relPath: string, content: string) => {
    const abs = path.join(root, relPath);
    const before = readIfExists(abs);
    if (before === content) {
      results.push({ file: relPath, changed: false });
    } else {
      writeText(abs, content);
      results.push({ file: relPath, changed: true });
    }
  };

  write(SKILL_PATH, renderSkill(profile, config));

  for (const cmd of slashCommands()) {
    const content = [
      "---",
      `description: ${cmd.description}`,
      "---",
      "",
      generatedFileHeader("harness skill sync"),
      "",
      cmd.body,
      "",
    ].join("\n");
    write(path.join(COMMANDS_DIR, cmd.file), content);
  }

  return results;
}
