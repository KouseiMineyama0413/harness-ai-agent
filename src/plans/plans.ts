/**
 * Implementation plans: the enforceable version of "present a plan before
 * changing code". Plans are JSON files under .harness/plans/ (committed),
 * created by agents, approved by humans. With agent.enforcePlan: true,
 * `guard scan-diff` fails while no approved plan exists.
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeJson } from "../core/fsutil.js";
import type { Plan, PlanStatus } from "../types.js";

export const PLANS_DIR = ".harness/plans";

function plansDir(root: string): string {
  return path.join(root, PLANS_DIR);
}

export function createPlan(
  root: string,
  title: string,
  opts: { requirement?: string; steps?: string[] } = {},
): { plan: Plan; file: string } {
  fs.mkdirSync(plansDir(root), { recursive: true });
  const count = fs.readdirSync(plansDir(root)).filter((f) => /^PLAN-\d+\.json$/.test(f)).length;
  const id = `PLAN-${String(count + 1).padStart(3, "0")}`;
  const plan: Plan = {
    schemaVersion: 1,
    id,
    title,
    status: "draft",
    createdAt: new Date().toISOString(),
    ...(opts.requirement ? { requirement: opts.requirement } : {}),
    steps: opts.steps ?? [],
  };
  const file = path.join(plansDir(root), `${id}.json`);
  writeJson(file, plan);
  return { plan, file };
}

export function loadPlan(root: string, id: string): Plan | null {
  return readJsonIfExists<Plan>(path.join(plansDir(root), `${id}.json`));
}

export function listPlans(root: string): Plan[] {
  try {
    return fs
      .readdirSync(plansDir(root))
      .filter((f) => /^PLAN-\d+\.json$/.test(f))
      .sort()
      .map((f) => readJsonIfExists<Plan>(path.join(plansDir(root), f)))
      .filter((p): p is Plan => p !== null);
  } catch {
    return [];
  }
}

const TRANSITIONS: Record<PlanStatus, PlanStatus[]> = {
  draft: ["approved", "rejected"],
  approved: ["completed", "rejected"],
  completed: [],
  rejected: ["draft"],
};

export function setPlanStatus(
  root: string,
  id: string,
  status: PlanStatus,
  by?: string,
): Plan {
  const plan = loadPlan(root, id);
  if (!plan) throw new Error(`plan not found: ${id}`);
  if (!TRANSITIONS[plan.status].includes(status)) {
    throw new Error(`invalid transition: ${plan.status} -> ${status}`);
  }
  const next: Plan = { ...plan, status };
  if (status === "approved") {
    next.approvedAt = new Date().toISOString();
    if (by) next.approvedBy = by;
  }
  if (status === "completed") next.completedAt = new Date().toISOString();
  writeJson(path.join(plansDir(root), `${id}.json`), next);
  return next;
}

/** Is there a currently-approved (not yet completed) plan? */
export function hasApprovedPlan(root: string): boolean {
  return listPlans(root).some((p) => p.status === "approved");
}
