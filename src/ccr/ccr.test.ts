import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compressReversible, formatMarker } from "./compress.js";
import { getOriginal, hashContent, isValidHandle, listObjects, pruneExpired, putOriginal } from "./store.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-ccr-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("store", () => {
  it("round-trips an original by handle", () => {
    const content = "hello world".repeat(100);
    const { hash, bytes } = putOriginal(root, content);
    expect(isValidHandle(hash)).toBe(true);
    expect(bytes).toBe(Buffer.byteLength(content));
    expect(getOriginal(root, hash)).toBe(content);
  });

  it("is content-addressed and idempotent", () => {
    const a = putOriginal(root, "same content");
    const b = putOriginal(root, "same content");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(hashContent("same content"));
    expect(listObjects(root)).toHaveLength(1);
  });

  it("rejects invalid or traversal handles", () => {
    expect(getOriginal(root, "../etc/passwd")).toBeNull();
    expect(getOriginal(root, "nothex!!")).toBeNull();
    expect(isValidHandle("abcd")).toBe(false);
  });

  it("prunes objects older than the retention window", () => {
    const { hash } = putOriginal(root, "old blob to expire");
    const file = path.join(root, ".harness/ccr", `${hash}.txt`);
    const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(file, old / 1000, old / 1000);
    expect(pruneExpired(root, 7)).toBe(1);
    expect(getOriginal(root, hash)).toBeNull();
  });
});

describe("compressReversible", () => {
  it("leaves small content untouched", () => {
    const r = compressReversible(root, "short text");
    expect(r.stored).toBe(false);
    expect(r.compressed).toBe("short text");
    expect(r.hash).toBeUndefined();
  });

  it("offloads the middle of large content and stays retrievable", () => {
    const big = "HEAD-START\n" + "x".repeat(5000) + "\nTAIL-END";
    const r = compressReversible(root, big, { headChars: 50, tailChars: 50 });
    expect(r.stored).toBe(true);
    expect(r.compressedChars).toBeLessThan(r.originalChars);
    expect(r.compressed).toContain("HEAD-START");
    expect(r.compressed).toContain("TAIL-END");
    expect(r.compressed).toContain(`<<ccr:${r.hash}`);
    // The marker handle retrieves the full original.
    expect(getOriginal(root, r.hash!)).toBe(big);
  });

  it("formatMarker embeds the handle and a retrieval hint", () => {
    const m = formatMarker("0123456789abcdef", 4200);
    expect(m).toContain("0123456789abcdef");
    expect(m).toContain("4200 chars omitted");
    expect(m).toContain("ccr_retrieve");
  });
});
