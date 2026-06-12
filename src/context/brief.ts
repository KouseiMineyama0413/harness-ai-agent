/**
 * Task brief generation.
 *
 * Opus-class models do their best long-horizon work when the FULL task
 * specification arrives in one well-specified opening turn, instead of
 * being discovered across many small follow-ups. `harness brief` composes
 * that turn from what the harness already knows: the requirement, the
 * approved plan, the stack/commands, guardrails, and a checkable
 * definition of done. Pipe it into an agent as the kickoff prompt.
 */
import type { HarnessConfig } from "../config/schema.js";
import { loadPlan, listPlans } from "../plans/plans.js";
import { loadRequirement } from "../requirements/requirements.js";
import type { ProjectProfile } from "../types.js";
import { tuningRules } from "./tuning.js";

export interface BriefOptions {
  /** Free-form task statement (used when no requirement is linked). */
  task?: string;
  /** Requirement id (REQ-xxx) to embed. */
  requirementId?: string;
  /** Plan id (PLAN-xxx); defaults to the latest approved plan. */
  planId?: string;
}

export function buildBrief(
  root: string,
  config: HarnessConfig,
  profile: ProjectProfile,
  opts: BriefOptions = {},
): string {
  const lines: string[] = [];

  const requirement = opts.requirementId
    ? (loadRequirement(root, opts.requirementId)?.req ?? null)
    : null;
  if (opts.requirementId && !requirement) {
    throw new Error(`requirement not found: ${opts.requirementId}`);
  }
  const plan = opts.planId
    ? loadPlan(root, opts.planId)
    : (listPlans(root).filter((p) => p.status === "approved").at(-1) ?? null);
  if (opts.planId && !plan) throw new Error(`plan not found: ${opts.planId}`);

  const title = requirement?.title ?? opts.task ?? plan?.title;
  if (!title) {
    throw new Error("nothing to brief — pass a task, --req <REQ-id>, or --plan <PLAN-id>");
  }

  lines.push(`# Task: ${title}`);
  lines.push("");
  lines.push(
    `Project: ${config.project.name}` +
      (config.project.description ? ` — ${config.project.description}` : ""),
  );
  lines.push("");

  if (requirement) {
    lines.push("## Requirement");
    if (requirement.summary) lines.push(requirement.summary, "");
    if (requirement.userStories.length > 0) {
      lines.push("User stories:");
      requirement.userStories.forEach((s) => lines.push(`- ${s}`));
      lines.push("");
    }
    if (requirement.acceptanceCriteria.length > 0) {
      lines.push("Acceptance criteria (the task is done when ALL of these hold):");
      requirement.acceptanceCriteria.forEach((c) => lines.push(`- ${c}`));
      lines.push("");
    }
    if (requirement.nonFunctional.length > 0) {
      lines.push("Non-functional requirements:");
      requirement.nonFunctional.forEach((n) => lines.push(`- ${n}`));
      lines.push("");
    }
    if (requirement.outOfScope.length > 0) {
      lines.push("Out of scope (do NOT do these):");
      requirement.outOfScope.forEach((o) => lines.push(`- ${o}`));
      lines.push("");
    }
  } else if (opts.task) {
    lines.push("## Task statement");
    lines.push(opts.task);
    lines.push("");
  }

  if (plan) {
    lines.push(`## Approved plan (${plan.id}${plan.approvedBy ? `, approved by ${plan.approvedBy}` : ""})`);
    plan.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }

  lines.push("## Environment");
  lines.push(
    `Stack: ${profile.technologies.map((t) => t.name + (t.version ? ` ${t.version}` : "")).join(", ") || "(run harness analyze)"}`,
  );
  const commands = { ...profile.inferredCommands };
  for (const [id, gate] of Object.entries(config.gates)) {
    if (gate?.command) commands[id as keyof typeof commands] = gate.command;
    if (gate?.command === null) delete commands[id as keyof typeof commands];
  }
  for (const [gate, cmd] of Object.entries(commands)) lines.push(`- ${gate}: \`${cmd}\``);
  lines.push("- Full project context: `.harness/context.md` (refresh with `harness context`)");
  lines.push("");

  lines.push("## Guardrails");
  const b = config.agent.changeBudget;
  lines.push(`- Change budget: ≤${b.maxFiles} files, +${b.maxLinesAdded}/-${b.maxLinesDeleted} lines.`);
  if (config.agent.protectedPaths.length > 0) {
    lines.push(`- Never modify: ${config.agent.protectedPaths.map((p) => `\`${p}\``).join(", ")}`);
  }
  lines.push("- Claim shared areas before editing (`harness claim add <path> --agent <you>`).");
  lines.push("- Verify risky shell commands first (`harness guard check-command`).");
  lines.push("");

  lines.push("## Definition of done");
  if (requirement?.acceptanceCriteria.length) {
    lines.push("- Every acceptance criterion above holds.");
  }
  lines.push("- `harness gate run` passes (all required gates).");
  lines.push("- `harness guard scan-diff --agent <you>` reports no violations.");
  lines.push("- Decisions recorded (`harness session decision`) and `harness session handoff` written.");
  lines.push("");

  const tuning = tuningRules(config);
  if (tuning) {
    lines.push(`## Operating instructions (${tuning.target})`);
    tuning.rules.forEach((r) => lines.push(`- ${r}`));
    lines.push("");
  }

  return lines.join("\n");
}
