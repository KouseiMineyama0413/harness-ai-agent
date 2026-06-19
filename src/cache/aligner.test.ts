import { describe, expect, it } from "vitest";
import { analyzeAlignment, summarizeAlignment } from "./aligner.js";

describe("analyzeAlignment", () => {
  it("returns a perfect score for stable text", () => {
    const r = analyzeAlignment("This is a stable system prompt with no volatile tokens.");
    expect(r.findings).toHaveLength(0);
    expect(r.score).toBe(100);
    expect(r.stablePrefixChars).toBe(r.totalChars);
    expect(summarizeAlignment(r)).toBeNull();
  });

  it("detects UUIDs, timestamps, hashes, and JWTs", () => {
    const text = [
      "session 550e8400-e29b-41d4-a716-446655440000",
      "generated 2026-06-19T13:00:00Z",
      "sha 5d41402abc4b2a76b9719d911017c592",
      "token eyJhbGciOi.JKV1QiLCJ.abc123_-x",
    ].join(" ");
    const r = analyzeAlignment(text);
    const kinds = r.findings.map((f) => f.kind).sort();
    expect(kinds).toContain("uuid");
    expect(kinds).toContain("iso8601");
    expect(kinds).toContain("hex_hash");
    expect(kinds).toContain("jwt");
    expect(r.score).toBeLessThan(100);
  });

  it("reports the stable prefix length up to the first volatile token", () => {
    const text = "stable header line\nmore stable text 550e8400-e29b-41d4-a716-446655440000 trailing";
    const r = analyzeAlignment(text);
    expect(r.stablePrefixChars).toBe(text.indexOf("550e8400"));
    expect(summarizeAlignment(r)).toContain("uuid=1");
  });

  it("does not misclassify a 32-char hex string as a UUID", () => {
    const r = analyzeAlignment("hash 5d41402abc4b2a76b9719d911017c592");
    expect(r.findings[0]!.kind).toBe("hex_hash");
  });

  it("ignores ordinary numbers and words", () => {
    const r = analyzeAlignment("version 22 with 800 lines and 3 gates");
    expect(r.findings).toHaveLength(0);
  });
});
