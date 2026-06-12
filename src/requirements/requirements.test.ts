import { describe, expect, it } from "vitest";
import type { Requirement } from "../types.js";
import { lintRequirement } from "./requirements.js";

function base(): Requirement {
  return {
    schemaVersion: 1,
    id: "REQ-001",
    title: "CSV export",
    status: "draft",
    createdAt: "2026-01-01T00:00:00.000Z",
    summary: "Users can export their order history as CSV from the orders page.",
    userStories: ["As a customer, I want to download my orders as CSV so I can do accounting."],
    acceptanceCriteria: [
      "Given a user with 1+ orders, when they click Export, a CSV downloads with columns id,date,total.",
    ],
    nonFunctional: ["Export of 10k rows completes within 5 seconds (p95)."],
    outOfScope: [],
    openQuestions: [],
  };
}

describe("lintRequirement", () => {
  it("passes a well-formed requirement", () => {
    expect(lintRequirement(base())).toHaveLength(0);
  });

  it("errors on missing acceptance criteria and empty summary", () => {
    const req = { ...base(), acceptanceCriteria: [], summary: "" };
    const findings = lintRequirement(req);
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(2);
  });

  it("flags vague terms in English and Japanese", () => {
    const req = { ...base(), summary: "The page should be fast and 適切に handle errors." };
    const messages = lintRequirement(req).map((f) => f.message);
    expect(messages.some((m) => m.includes('"fast"'))).toBe(true);
    expect(messages.some((m) => m.includes("曖昧表現"))).toBe(true);
  });

  it("blocks approval while open questions remain", () => {
    const req = { ...base(), status: "approved" as const, openQuestions: ["Which timezone?"] };
    const findings = lintRequirement(req);
    expect(findings.some((f) => f.severity === "error" && f.message.includes("open question"))).toBe(true);
  });
});
