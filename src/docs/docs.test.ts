import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generatedFileHeader, isGeneratedFile } from "../core/markers.js";
import type { ProjectProfile } from "../types.js";
import { checkDocs } from "./generate.js";
import { collectDocSources } from "./sources.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-docs-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function profileWith(layout: Record<string, string>, notableFiles: string[] = []): ProjectProfile {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    root,
    name: "demo",
    technologies: [],
    inferredCommands: {},
    inferredChangedCommands: {},
    layout,
    notableFiles,
    notes: [],
  };
}

describe("collectDocSources", () => {
  it("collects layout, manifests and entry points with caps, skipping absent files", () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo" }));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/index.ts"), "export const app = 1;\n");
    fs.writeFileSync(path.join(root, ".env.example"), "DATABASE_URL=postgres://localhost/demo\n");

    const sources = collectDocSources(root, profileWith({ "src/": "application source" }));
    const paths = sources.map((s) => s.path);
    expect(paths[0]).toBe("(top-level layout)");
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain(".env.example");
    expect(paths).not.toContain("go.mod");
  });

  it("truncates oversized files", () => {
    fs.writeFileSync(path.join(root, "package.json"), "x".repeat(20_000));
    const sources = collectDocSources(root, profileWith({}));
    const pkg = sources.find((s) => s.path === "package.json");
    expect(pkg?.content.length).toBeLessThan(10_000);
    expect(pkg?.content).toContain("[truncated]");
  });
});

describe("checkDocs", () => {
  it("flags missing docs and accepts fresh ones", () => {
    fs.writeFileSync(path.join(root, "README.md"), "# demo");
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs/architecture.md"), "fresh");

    const findings = checkDocs(root);
    expect(findings.find((f) => f.file === "README.md")?.status).toBe("ok");
    expect(findings.find((f) => f.file === "docs/architecture.md")?.status).toBe("ok");
    expect(findings.find((f) => f.file === "docs/api.md")?.status).toBe("missing");
    expect(findings.find((f) => f.file === "docs/onboarding.md")?.status).toBe("missing");
  });
});

describe("generated-file detection", () => {
  it("round-trips the header through isGeneratedFile", () => {
    expect(isGeneratedFile(generatedFileHeader("harness docs generate") + "\n# x")).toBe(true);
    expect(isGeneratedFile("# human written doc")).toBe(false);
  });
});
