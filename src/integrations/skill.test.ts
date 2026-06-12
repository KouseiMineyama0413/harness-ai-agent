import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { harnessConfigSchema } from "../config/schema.js";
import type { ProjectProfile } from "../types.js";
import { renderSkill, SKILL_PATH, syncSkillAndCommands } from "./skill.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skill-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const profile: ProjectProfile = {
  schemaVersion: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  root: "/tmp/x",
  name: "demo",
  technologies: [
    { id: "typescript", name: "TypeScript", kind: "language", evidence: [], confidence: 1 },
  ],
  inferredCommands: { test: "pnpm test", lint: "pnpm lint" },
  inferredChangedCommands: {},
  layout: {},
  notableFiles: [],
  notes: ["[S-001] CSV export: stream rows, no in-memory buffer"],
};

const config = harnessConfigSchema.parse({
  version: 1,
  project: { name: "demo" },
  agent: { enforcePlan: true, protectedPaths: ["infra/"] },
  gates: { test: { command: "pnpm vitest run" } },
  context: { rules: ["DB schema changes go through migrations"] },
});

describe("renderSkill", () => {
  it("projects stack, resolved commands, guardrails, and lessons into the skill", () => {
    const skill = renderSkill(profile, config);
    expect(skill).toContain("name: dev-harness");
    expect(skill).toContain("TypeScript");
    // Config command overrides the inferred one.
    expect(skill).toContain("test: `pnpm vitest run`");
    expect(skill).toContain("lint: `pnpm lint`");
    expect(skill).toContain("approved plan is REQUIRED");
    expect(skill).toContain("`infra/`");
    expect(skill).toContain("DB schema changes go through migrations");
    expect(skill).toContain("stream rows, no in-memory buffer");
    expect(skill).toContain("AUTO-GENERATED");
  });
});

describe("syncSkillAndCommands", () => {
  it("writes the skill and slash commands, and is idempotent", () => {
    const first = syncSkillAndCommands(root, profile, config);
    expect(first.every((r) => r.changed)).toBe(true);
    expect(fs.existsSync(path.join(root, SKILL_PATH))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude/commands/harness-gate.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".claude/commands/harness-handoff.md"))).toBe(true);

    const second = syncSkillAndCommands(root, profile, config);
    expect(second.every((r) => !r.changed)).toBe(true);
  });

  it("propagates new project lessons into the skill on re-sync", () => {
    syncSkillAndCommands(root, profile, config);
    const updated = { ...profile, notes: [...profile.notes, "[S-002] use pnpm only"] };
    const results = syncSkillAndCommands(root, updated, config);
    expect(results.find((r) => r.file === SKILL_PATH)?.changed).toBe(true);
    expect(fs.readFileSync(path.join(root, SKILL_PATH), "utf8")).toContain("use pnpm only");
  });
});
