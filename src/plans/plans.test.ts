import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPlan, hasApprovedPlan, listPlans, setPlanStatus } from "./plans.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-plans-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("plans", () => {
  it("walks the lifecycle draft -> approved -> completed", () => {
    const { plan } = createPlan(root, "CSV export", {
      requirement: "REQ-001",
      steps: ["add endpoint", "stream rows", "tests"],
    });
    expect(plan.id).toBe("PLAN-001");
    expect(hasApprovedPlan(root)).toBe(false);

    const approved = setPlanStatus(root, "PLAN-001", "approved", "kosei");
    expect(approved.approvedBy).toBe("kosei");
    expect(hasApprovedPlan(root)).toBe(true);

    setPlanStatus(root, "PLAN-001", "completed");
    expect(hasApprovedPlan(root)).toBe(false);
  });

  it("rejects invalid transitions", () => {
    createPlan(root, "x");
    expect(() => setPlanStatus(root, "PLAN-001", "completed")).toThrow(/invalid transition/);
    setPlanStatus(root, "PLAN-001", "rejected");
    expect(() => setPlanStatus(root, "PLAN-001", "approved")).toThrow(/invalid transition/);
    // rejected -> draft -> approved is allowed
    setPlanStatus(root, "PLAN-001", "draft");
    setPlanStatus(root, "PLAN-001", "approved");
    expect(listPlans(root)[0]?.status).toBe("approved");
  });
});
