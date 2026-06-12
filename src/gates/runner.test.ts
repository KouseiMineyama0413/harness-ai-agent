import { describe, expect, it } from "vitest";
import { defaultConfig, harnessConfigSchema } from "../config/schema.js";
import type { ProjectProfile } from "../types.js";
import { gatesPassed, parseCoverage, resolveGates } from "./runner.js";

function profileWith(commands: ProjectProfile["inferredCommands"]): ProjectProfile {
  return {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    root: "/tmp/x",
    name: "x",
    technologies: [],
    inferredCommands: commands,
    layout: {},
    notableFiles: [],
    notes: [],
  };
}

describe("resolveGates", () => {
  it("prefers config commands over adapter inference", () => {
    const config = harnessConfigSchema.parse({
      version: 1,
      project: { name: "x" },
      gates: { test: { command: "make test" } },
    });
    const { resolved } = resolveGates(config, profileWith({ test: "npm test" }));
    const test = resolved.find((g) => g.id === "test");
    expect(test?.command).toBe("make test");
    expect(test?.source).toBe("config");
  });

  it("skips gates with no command, and disabled gates", () => {
    const config = harnessConfigSchema.parse({
      version: 1,
      project: { name: "x" },
      gates: { lint: { command: null } },
    });
    const { resolved, skipped } = resolveGates(config, profileWith({ lint: "eslint .", test: "npm t" }));
    expect(resolved.map((g) => g.id)).toEqual(["test"]);
    expect(skipped.find((s) => s.id === "lint")?.reason).toBe("disabled in harness.yaml");
  });

  it("respects --only subsets", () => {
    const config = defaultConfig("x");
    const { resolved } = resolveGates(config, profileWith({ lint: "a", test: "b" }), ["test"]);
    expect(resolved.map((g) => g.id)).toEqual(["test"]);
  });
});

describe("gatesPassed", () => {
  it("ignores optional gate failures but not required ones", () => {
    expect(
      gatesPassed([
        { id: "test", status: "passed", durationMs: 0, output: "", required: true },
        { id: "security", status: "failed", durationMs: 0, output: "", required: false },
      ]),
    ).toBe(true);
    expect(
      gatesPassed([{ id: "test", status: "failed", durationMs: 0, output: "", required: true }]),
    ).toBe(false);
  });
});

describe("parseCoverage", () => {
  it("parses istanbul, pytest-cov and go formats", () => {
    expect(parseCoverage("All files |   84.21 |   70 |")).toBe(84.21);
    expect(parseCoverage("TOTAL     1200    192    84%")).toBe(84);
    expect(parseCoverage("coverage: 84.2% of statements")).toBe(84.2);
    expect(parseCoverage("no coverage here")).toBeNull();
  });
});
