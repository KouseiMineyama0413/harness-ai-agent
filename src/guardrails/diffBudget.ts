/**
 * Diff-level guardrails: change budget, protected paths, introduced secrets.
 * Reads the working tree diff via git; requires the project to be a git repo.
 */
import { execFileSync } from "node:child_process";
import type { HarnessConfig } from "../config/schema.js";
import { hasApprovedPlan } from "../plans/plans.js";
import type { DiffCheckResult } from "../types.js";
import { findClaimConflicts, listClaims } from "./claims.js";
import { findSecrets } from "./secrets.js";

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
}

export function isGitRepo(root: string): boolean {
  try {
    git(root, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Simple prefix/glob matcher: supports "dir/", "dir/**", "*.ext", exact paths. */
export function matchesProtected(file: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const p = raw.replace(/\/\*\*$/, "/").replace(/^\.\//, "");
    if (p.startsWith("*.")) {
      if (file.endsWith(p.slice(1))) return true;
    } else if (p.endsWith("/")) {
      if (file.startsWith(p)) return true;
    } else if (file === p || file.startsWith(p + "/")) {
      return true;
    }
  }
  return false;
}

export interface CheckDiffOptions {
  /** Compare against a base ref (CI on PRs) instead of the working tree. */
  baseRef?: string;
  /** Agent performing the change; used for claim conflict checks. */
  agent?: string;
}

/**
 * Check the current uncommitted diff (staged + unstaged) against the
 * configured change budget, protected paths, other agents' claims, plan
 * enforcement and secret introduction.
 */
export function checkDiff(
  root: string,
  config: HarnessConfig,
  opts: CheckDiffOptions = {},
): DiffCheckResult {
  const range = opts.baseRef ? [`${opts.baseRef}...HEAD`] : ["HEAD"];
  const agent = opts.agent ?? "human";

  const numstat = git(root, ["diff", "--numstat", ...range]).trim();
  const nameOnly = git(root, ["diff", "--name-only", ...range]).trim();

  const files = nameOnly ? nameOnly.split("\n") : [];
  let linesAdded = 0;
  let linesDeleted = 0;
  for (const row of numstat ? numstat.split("\n") : []) {
    const [add, del] = row.split("\t");
    // Binary files show "-"; count them as 0 lines.
    linesAdded += Number.parseInt(add ?? "0", 10) || 0;
    linesDeleted += Number.parseInt(del ?? "0", 10) || 0;
  }

  const budget = config.agent.changeBudget;
  const violations: string[] = [];
  if (files.length > budget.maxFiles) {
    violations.push(`files changed ${files.length} > budget ${budget.maxFiles}`);
  }
  if (linesAdded > budget.maxLinesAdded) {
    violations.push(`lines added ${linesAdded} > budget ${budget.maxLinesAdded}`);
  }
  if (linesDeleted > budget.maxLinesDeleted) {
    violations.push(`lines deleted ${linesDeleted} > budget ${budget.maxLinesDeleted}`);
  }

  const protectedTouched = files.filter((f) => matchesProtected(f, config.agent.protectedPaths));
  if (protectedTouched.length > 0) {
    violations.push(`protected paths touched: ${protectedTouched.join(", ")}`);
  }

  const claimConflicts = findClaimConflicts(files, agent, listClaims(root));
  if (claimConflicts.length > 0) {
    violations.push(
      `files claimed by another agent: ${claimConflicts
        .map((c) => `${c.file} (claimed by ${c.claimedBy} via ${c.path})`)
        .join(", ")}`,
    );
  }

  const planMissing = config.agent.enforcePlan && files.length > 0 && !hasApprovedPlan(root);
  if (planMissing) {
    violations.push(
      "no approved plan — agent.enforcePlan is on; create one with `harness plan new` and have a human run `harness plan approve`",
    );
  }

  // Scan only added lines for secrets.
  const secretFindings: DiffCheckResult["secretFindings"] = [];
  const diffText = git(root, ["diff", "--unified=0", ...range]);
  let currentFile = "";
  const addedByFile = new Map<string, string[]>();
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("+") && !line.startsWith("+++") && currentFile) {
      const arr = addedByFile.get(currentFile) ?? [];
      arr.push(line.slice(1));
      addedByFile.set(currentFile, arr);
    }
  }
  for (const [file, lines] of addedByFile) {
    for (const f of findSecrets(lines.join("\n"))) {
      secretFindings.push({ file, line: f.line, kind: f.kind });
    }
  }
  if (secretFindings.length > 0) {
    violations.push(
      `potential secrets introduced: ${secretFindings.map((s) => `${s.file} (${s.kind})`).join(", ")}`,
    );
  }

  return {
    ok: violations.length === 0,
    filesChanged: files.length,
    linesAdded,
    linesDeleted,
    violations,
    protectedTouched,
    secretFindings,
    claimConflicts,
    planMissing,
  };
}
