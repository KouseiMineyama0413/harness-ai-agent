import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beginMarker, endMarker, upsertMarkedBlock } from "./markers.js";

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-markers-"));
  file = path.join(root, "CLAUDE.md");
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const read = () => fs.readFileSync(file, "utf8");

describe("upsertMarkedBlock", () => {
  it("creates the file when missing", () => {
    expect(upsertMarkedBlock(file, "integration", "## rules\n- a")).toBe("created");
    expect(read()).toContain(beginMarker("integration"));
    expect(read()).toContain(endMarker("integration"));
  });

  it("appends to an existing file without markers, preserving human content", () => {
    fs.writeFileSync(file, "# My project\n\nHuman notes.\n");
    expect(upsertMarkedBlock(file, "integration", "- rule")).toBe("appended");
    expect(read()).toMatch(/^# My project\n\nHuman notes\./);
    expect(read()).toContain("- rule");
  });

  it("updates only the managed region on re-run, and reports unchanged when identical", () => {
    fs.writeFileSync(file, "before\n");
    upsertMarkedBlock(file, "integration", "- v1");
    fs.appendFileSync(file, "\nhuman text after\n");

    expect(upsertMarkedBlock(file, "integration", "- v2")).toBe("updated");
    const content = read();
    expect(content).toContain("- v2");
    expect(content).not.toContain("- v1");
    expect(content).toMatch(/^before\n/);
    expect(content).toContain("human text after");

    expect(upsertMarkedBlock(file, "integration", "- v2")).toBe("unchanged");
  });

  it("upgrades legacy begin-only blocks (old append-once format at EOF)", () => {
    fs.writeFileSync(file, `human intro\n\n${beginMarker("integration")}\n## old rules\n- legacy\n`);
    expect(upsertMarkedBlock(file, "integration", "## new rules\n- fresh")).toBe("updated");
    const content = read();
    expect(content).toContain("human intro");
    expect(content).toContain("- fresh");
    expect(content).not.toContain("- legacy");
    expect(content).toContain(endMarker("integration"));
  });

  it("manages multiple independent blocks in one file", () => {
    upsertMarkedBlock(file, "integration", "- rules");
    upsertMarkedBlock(file, "docs", "- docs info");
    upsertMarkedBlock(file, "integration", "- rules v2");
    const content = read();
    expect(content).toContain("- rules v2");
    expect(content).toContain("- docs info");
  });
});
