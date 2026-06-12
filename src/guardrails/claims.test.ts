import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addClaim, findClaimConflicts, listClaims, releaseAgentClaims, releaseClaim } from "./claims.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-claims-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("claims", () => {
  it("claims, lists and releases paths", () => {
    addClaim(root, "src/billing/", "claude", "refactoring invoices");
    expect(listClaims(root)).toHaveLength(1);
    expect(listClaims(root)[0]?.path).toBe("src/billing"); // normalized

    releaseClaim(root, "src/billing", "claude");
    expect(listClaims(root)).toHaveLength(0);
  });

  it("rejects overlapping claims from a different agent, both directions", () => {
    addClaim(root, "src/billing", "claude");
    expect(() => addClaim(root, "src/billing/invoice.ts", "codex")).toThrow(/held by claude/);
    expect(() => addClaim(root, "src", "codex")).toThrow(/held by claude/);
    // Same agent may deepen its own claim; sibling paths are fine for others.
    expect(() => addClaim(root, "src/billing/invoice.ts", "claude")).not.toThrow();
    expect(() => addClaim(root, "src/auth", "codex")).not.toThrow();
  });

  it("prevents releasing another agent's claim", () => {
    addClaim(root, "src/billing", "claude");
    expect(() => releaseClaim(root, "src/billing", "codex")).toThrow(/held by claude/);
  });

  it("release-all clears one agent's claims only", () => {
    addClaim(root, "src/a", "claude");
    addClaim(root, "src/b", "claude");
    addClaim(root, "src/c", "codex");
    expect(releaseAgentClaims(root, "claude")).toBe(2);
    expect(listClaims(root).map((c) => c.agent)).toEqual(["codex"]);
  });

  it("finds conflicts for changed files under another agent's claim", () => {
    addClaim(root, "src/billing", "claude");
    const conflicts = findClaimConflicts(
      ["src/billing/invoice.ts", "src/auth/login.ts", "src/billingX/other.ts"],
      "codex",
      listClaims(root),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ file: "src/billing/invoice.ts", claimedBy: "claude" });

    // The claiming agent itself has no conflicts.
    expect(findClaimConflicts(["src/billing/invoice.ts"], "claude", listClaims(root))).toHaveLength(0);
  });
});
