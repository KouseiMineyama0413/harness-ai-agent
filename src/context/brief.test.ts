import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../config/schema.js";
import { writeJson } from "../core/fsutil.js";
import { createPlan, setPlanStatus } from "../plans/plans.js";
import type { ProjectProfile, Requirement } from "../types.js";
import { buildBrief } from "./brief.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-brief-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const profile: ProjectProfile = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  root: "/tmp/x",
  name: "demo",
  technologies: [{ id: "node", name: "Node.js", kind: "language", evidence: [], confidence: 1 }],
  inferredCommands: { test: "pnpm test" },
  inferredChangedCommands: {},
  layout: {},
  notableFiles: [],
  notes: [],
};

const config = harnessConfigSchema.parse({
  version: 1,
  project: { name: "demo" },
  agent: { protectedPaths: ["infra/"] },
});

function writeRequirement(): void {
  const req: Requirement = {
    schemaVersion: 1,
    id: "REQ-001",
    title: "CSV export",
    status: "approved",
    createdAt: "2026-01-01T00:00:00.000Z",
    summary: "Users can export order history as CSV.",
    userStories: ["As a customer, I download my orders."],
    acceptanceCriteria: ["GET /orders/export returns a CSV with id,date,total."],
    nonFunctional: ["10k rows export within 5s (p95)."],
    outOfScope: ["PDF export"],
    openQuestions: [],
  };
  writeJson(path.join(root, ".harness/requirements/REQ-001-csv-export.json"), req);
}

describe("buildBrief", () => {
  it("composes requirement, approved plan, commands, guardrails, done criteria and tuning", () => {
    writeRequirement();
    createPlan(root, "CSV export", { steps: ["add endpoint", "stream rows"] });
    setPlanStatus(root, "PLAN-001", "approved", "kosei");

    const brief = buildBrief(root, config, profile, { requirementId: "REQ-001" });
    expect(brief).toContain("# Task: CSV export");
    expect(brief).toContain("GET /orders/export returns a CSV");
    expect(brief).toContain("Out of scope (do NOT do these):");
    expect(brief).toContain("PDF export");
    expect(brief).toContain("Approved plan (PLAN-001, approved by kosei)");
    expect(brief).toContain("1. add endpoint");
    expect(brief).toContain("test: `pnpm test`");
    expect(brief).toContain("Never modify: `infra/`");
    expect(brief).toContain("## Definition of done");
    expect(brief).toContain("Operating instructions (Claude Opus 4.8)");
  });

  it("works with a free-form task and no plan", () => {
    const brief = buildBrief(root, config, profile, { task: "fix the login redirect" });
    expect(brief).toContain("# Task: fix the login redirect");
    expect(brief).not.toContain("Approved plan");
  });

  it("omits the tuning section when agent.tuning is none", () => {
    const noTuning = harnessConfigSchema.parse({
      version: 1,
      project: { name: "demo" },
      agent: { tuning: "none" },
    });
    const brief = buildBrief(root, noTuning, profile, { task: "x" });
    expect(brief).not.toContain("Operating instructions");
  });

  it("errors when given nothing to brief or unknown ids", () => {
    expect(() => buildBrief(root, config, profile)).toThrow(/nothing to brief/);
    expect(() => buildBrief(root, config, profile, { requirementId: "REQ-999" })).toThrow(/not found/);
  });
});
