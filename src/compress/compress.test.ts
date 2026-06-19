import { describe, expect, it } from "vitest";
import { detectContentType } from "./detect.js";
import { compressDiff } from "./diff.js";
import { compressJson } from "./json.js";
import { compressLog } from "./log.js";
import { compress } from "./router.js";

describe("detectContentType", () => {
  it("classifies json, diff, log, and text", () => {
    expect(detectContentType('[{"a":1}]')).toBe("json");
    expect(detectContentType("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b")).toBe("diff");
    const log = Array.from({ length: 12 }, (_, i) => (i % 2 ? `INFO step ${i}` : `2026-06-19T10:00:0${i} ok`)).join("\n");
    expect(detectContentType(log)).toBe("log");
    expect(detectContentType("just some prose about a topic")).toBe("text");
  });
});

describe("compressJson", () => {
  it("crushes an array of objects into a key header + rows", () => {
    const arr = Array.from({ length: 5 }, (_, i) => ({ id: i, name: `n${i}`, status: "active" }));
    const r = compressJson(JSON.stringify(arr, null, 2));
    expect(r.compressed).toContain("5 objects, keys: id, name, status");
    expect(r.compressed).toContain("id\tname\tstatus");
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });

  it("samples long arrays with an omitted count", () => {
    const arr = Array.from({ length: 200 }, (_, i) => ({ id: i }));
    const r = compressJson(JSON.stringify(arr), { maxRows: 40 });
    expect(r.compressed).toContain("rows omitted");
    expect(r.ratio).toBeGreaterThan(0.5);
  });

  it("minifies pretty-printed objects as a fallback", () => {
    const r = compressJson('{\n  "a": 1,\n  "b": 2\n}');
    expect(r.compressed).toBe('{"a":1,"b":2}');
  });
});

describe("compressLog", () => {
  it("keeps error lines and head/tail, collapsing the rest", () => {
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => `progress ${i}`),
      "ERROR: something exploded",
      ...Array.from({ length: 40 }, (_, i) => `more progress ${i}`),
    ];
    const r = compressLog(lines.join("\n"), { headLines: 5, tailLines: 5 });
    expect(r.compressed).toContain("ERROR: something exploded");
    expect(r.compressed).toMatch(/… \d+ lines …/);
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });

  it("collapses consecutive duplicate lines", () => {
    const text = ["start", ...Array(20).fill("retrying..."), "ERROR boom", ...Array(10).fill("tail")].join("\n");
    const r = compressLog(text, { headLines: 2, tailLines: 2 });
    expect(r.compressed).toMatch(/retrying\.\.\. \(×\d+\)|… \d+ lines …/);
    expect(r.compressed).toContain("ERROR boom");
  });
});

describe("compressDiff", () => {
  it("trims long unchanged context but keeps changed lines and headers", () => {
    const diff = [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -1,30 +1,30 @@",
      ...Array.from({ length: 20 }, (_, i) => ` context ${i}`),
      "-removed line",
      "+added line",
      ...Array.from({ length: 20 }, (_, i) => ` more context ${i}`),
    ].join("\n");
    const r = compressDiff(diff, { context: 3 });
    expect(r.compressed).toContain("diff --git a/f b/f");
    expect(r.compressed).toContain("-removed line");
    expect(r.compressed).toContain("+added line");
    expect(r.compressed).toMatch(/… \d+ unchanged …/);
    expect(r.compressedChars).toBeLessThan(r.originalChars);
  });
});

describe("router", () => {
  it("leaves short content unchanged", () => {
    const r = compress("tiny");
    expect(r.compressed).toBe("tiny");
    expect(r.ratio).toBe(0);
  });

  it("routes by detected type and never grows the input", () => {
    const arr = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, v: `value-${i}` })), null, 2);
    const r = compress(arr);
    expect(r.contentType).toBe("json");
    expect(r.compressedChars).toBeLessThanOrEqual(arr.length);
  });
});
