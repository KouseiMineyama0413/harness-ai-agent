import { describe, expect, it } from "vitest";
import { findSecrets, redactSecrets } from "./secrets.js";

describe("redactSecrets", () => {
  it("redacts AWS access keys", () => {
    // harness-allow-secret
    const out = redactSecrets("key=AKIAIOSFODNN7EXAMPLE done");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED:aws-access-key]");
  });

  it("redacts github tokens and connection strings", () => {
    const input = [
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", // harness-allow-secret
      "db: postgres://user:supersecretpw@db.internal:5432/app", // harness-allow-secret
    ].join("\n");
    const out = redactSecrets(input);
    expect(out).toContain("[REDACTED:github-token]");
    expect(out).toContain("[REDACTED:connection-string]");
  });

  it("leaves normal output untouched", () => {
    const text = "Tests: 12 passed, 0 failed\nDone in 3.2s";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("findSecrets", () => {
  it("reports line numbers for assignments", () => {
    const content = ["line one", 'API_KEY = "abcd1234efgh5678ijkl"', "line three"].join("\n"); // harness-allow-secret
    const findings = findSecrets(content);
    expect(findings.some((f) => f.line === 2)).toBe(true);
  });

  it("honors harness-allow-secret opt-out", () => {
    const content = 'PASSWORD = "fixture-value-12345" # harness-allow-secret';
    expect(findSecrets(content)).toHaveLength(0);
  });
});
