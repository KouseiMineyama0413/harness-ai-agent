/**
 * Agent integration installers.
 *
 * `harness integrate claude` — wires a Claude Code UserPromptSubmit hook
 * into .claude/settings.json so every prompt is recorded automatically,
 * and appends usage rules to CLAUDE.md.
 *
 * `harness integrate codex` — Codex has no prompt hook, so the contract
 * lives in AGENTS.md (which Codex reads): log prompts/decisions via the
 * harness CLI and write a handoff before stopping.
 */
import fs from "node:fs";
import path from "node:path";
import { readIfExists, readJsonIfExists, writeJson } from "../core/fsutil.js";
import { upsertMarkedBlock } from "../core/markers.js";

const HOOK_COMMAND = "harness session prompt --from-claude-hook";

function agentRules(agent: "claude" | "codex"): string {
  const lines = [
    "## dev-harness",
    "",
    "This repository uses dev-harness for shared agent sessions, prompt history, and guardrails.",
    "Sessions are shared between Claude and Codex via files under `.harness/` — always:",
    "",
    "1. Read `.harness/context.md` before starting (refresh: `harness context`). It includes the active shared session.",
    `2. If no session is active, run: \`harness session start "<task>" --agent ${agent}\`. If one is active, just keep working — your events join it.`,
  ];
  if (agent === "codex") {
    lines.push(
      `3. Record each user prompt you receive: \`harness session prompt "<text>" --agent codex\` (history: \`.harness/prompt_history.jsonl\`).`,
    );
  } else {
    lines.push(
      "3. Prompts are recorded automatically via the UserPromptSubmit hook (history: `.harness/prompt_history.jsonl`).",
    );
  }
  lines.push(
    `4. Log key design decisions: \`harness session decision "<text>" --agent ${agent}\`.`,
    `5. Claim shared areas before editing them: \`harness claim add <path> --agent ${agent}\`; release when done.`,
    `6. Check risky commands first: \`harness guard check-command "<cmd>"\`. Run \`harness gate run\` (or \`--changed\`) after changes.`,
    `7. Before stopping: \`harness session handoff --agent ${agent}\` so the other agent can continue.`,
  );
  return lines.join("\n");
}

/** Upsert the managed rules block; returns true when the file changed. */
function syncRules(file: string, agent: "claude" | "codex"): boolean {
  return upsertMarkedBlock(file, "integration", agentRules(agent)) !== "unchanged";
}

interface ClaudeSettings {
  hooks?: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
  [key: string]: unknown;
}

export function integrateClaude(root: string): string[] {
  const changes: string[] = [];

  const settingsPath = path.join(root, ".claude", "settings.json");
  const settings = readJsonIfExists<ClaudeSettings>(settingsPath) ?? {};
  const hooks = (settings.hooks ??= {});
  const entries = (hooks["UserPromptSubmit"] ??= []);
  const installed = entries.some((e) => e.hooks?.some((h) => h.command === HOOK_COMMAND));
  if (!installed) {
    entries.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
    writeJson(settingsPath, settings);
    changes.push(`.claude/settings.json: added UserPromptSubmit hook (auto prompt history)`);
  }

  if (syncRules(path.join(root, "CLAUDE.md"), "claude")) {
    changes.push("CLAUDE.md: dev-harness rules block synced");
  }
  return changes;
}

export function integrateCodex(root: string): string[] {
  const changes: string[] = [];
  if (syncRules(path.join(root, "AGENTS.md"), "codex")) {
    changes.push("AGENTS.md: dev-harness rules block synced (Codex reads AGENTS.md)");
  }
  return changes;
}

export function isClaudeHookInstalled(root: string): boolean {
  const settings = readJsonIfExists<ClaudeSettings>(path.join(root, ".claude", "settings.json"));
  return JSON.stringify(settings ?? {}).includes(HOOK_COMMAND);
}

const GIT_HOOK_MARKER = "# dev-harness hook";

const GIT_HOOKS: Record<string, string> = {
  "pre-commit": `#!/bin/sh
${GIT_HOOK_MARKER}
# Block commits that violate the change budget, protected paths,
# other agents' claims, or introduce secrets.
harness guard scan-diff || {
  echo "dev-harness: guard scan-diff failed — fix violations or adjust harness.yaml" >&2
  exit 1
}
`,
  "pre-push": `#!/bin/sh
${GIT_HOOK_MARKER}
# Run quality gates before anything leaves the machine.
harness gate run || {
  echo "dev-harness: quality gates failed — see .harness/reports/" >&2
  exit 1
}
`,
};

/** Install pre-commit / pre-push hooks into .git/hooks (backing up foreign ones). */
export function integrateGitHooks(root: string): string[] {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!fs.existsSync(path.join(root, ".git"))) {
    throw new Error("not a git repository — run `git init` first");
  }
  fs.mkdirSync(hooksDir, { recursive: true });

  const changes: string[] = [];
  for (const [name, content] of Object.entries(GIT_HOOKS)) {
    const file = path.join(hooksDir, name);
    const existing = readIfExists(file);
    if (existing?.includes(GIT_HOOK_MARKER)) continue; // already ours
    if (existing) {
      fs.copyFileSync(file, file + ".bak");
      changes.push(`.git/hooks/${name}: existing hook backed up to ${name}.bak`);
    }
    fs.writeFileSync(file, content, { mode: 0o755 });
    changes.push(`.git/hooks/${name}: installed`);
  }
  return changes;
}
