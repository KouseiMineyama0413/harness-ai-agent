import path from "node:path";
import { fileExists, readJsonIfExists } from "../core/fsutil.js";
import type { DetectedTechnology, GateId } from "../types.js";
import type { AdapterDetection, StackAdapter } from "./types.js";

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

const FRAMEWORKS: { dep: string; id: string; name: string }[] = [
  { dep: "next", id: "nextjs", name: "Next.js" },
  { dep: "react", id: "react", name: "React" },
  { dep: "@nestjs/core", id: "nestjs", name: "NestJS" },
  { dep: "express", id: "express", name: "Express" },
  { dep: "fastify", id: "fastify", name: "Fastify" },
  { dep: "vue", id: "vue", name: "Vue" },
];

function detectPackageManager(root: string, pkg: PackageJson): string {
  if (pkg.packageManager?.startsWith("pnpm")) return "pnpm";
  if (pkg.packageManager?.startsWith("yarn")) return "yarn";
  if (fileExists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fileExists(path.join(root, "yarn.lock"))) return "yarn";
  if (fileExists(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function runScript(pm: string, script: string): string {
  return pm === "npm" ? `npm run ${script}` : `${pm} run ${script}`;
}

export const nodeAdapter: StackAdapter = {
  id: "node",

  applies(root: string): boolean {
    return fileExists(path.join(root, "package.json"));
  },

  detect(root: string): AdapterDetection {
    const pkg = readJsonIfExists<PackageJson>(path.join(root, "package.json")) ?? {};
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const scripts = pkg.scripts ?? {};
    const pm = detectPackageManager(root, pkg);

    const technologies: DetectedTechnology[] = [
      {
        id: "node",
        name: "Node.js",
        kind: "language",
        evidence: ["package.json"],
        confidence: 1,
      },
    ];
    if (deps["typescript"] || fileExists(path.join(root, "tsconfig.json"))) {
      technologies.push({
        id: "typescript",
        name: "TypeScript",
        kind: "language",
        version: deps["typescript"],
        evidence: ["tsconfig.json", "package.json"].filter((f) => fileExists(path.join(root, f))),
        confidence: 1,
      });
    }
    for (const fw of FRAMEWORKS) {
      if (deps[fw.dep]) {
        technologies.push({
          id: fw.id,
          name: fw.name,
          kind: "framework",
          version: deps[fw.dep],
          evidence: [`package.json: ${fw.dep}`],
          confidence: 0.95,
        });
      }
    }

    // Prefer the project's own scripts; fall back to well-known tools.
    const commands: Partial<Record<GateId, string>> = {};
    const script = (names: string[]): string | undefined => {
      const hit = names.find((n) => scripts[n]);
      return hit ? runScript(pm, hit) : undefined;
    };
    commands.lint = script(["lint"]) ?? (deps["eslint"] ? "npx eslint ." : undefined);
    commands.typecheck =
      script(["typecheck", "type-check", "check-types"]) ??
      (deps["typescript"] || fileExists(path.join(root, "tsconfig.json"))
        ? "npx tsc --noEmit"
        : undefined);
    commands.test = script(["test"]);
    commands.build = script(["build"]);
    commands.deps =
      pm === "pnpm" ? "pnpm audit --audit-level high" : pm === "yarn" ? "yarn npm audit" : "npm audit --audit-level=high";
    commands.security = commands.deps;

    const changedCommands: Partial<Record<GateId, string>> = {};
    if (deps["vitest"]) {
      changedCommands.test = "npx vitest related --run {files}";
    } else if (deps["jest"]) {
      changedCommands.test = "npx jest --findRelatedTests {files} --passWithNoTests";
    }
    if (deps["eslint"]) changedCommands.lint = "npx eslint {files}";

    const notableFiles = [
      "package.json",
      "tsconfig.json",
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
      "nest-cli.json",
      "vite.config.ts",
    ].filter((f) => fileExists(path.join(root, f)));

    return { technologies, commands, changedCommands, notableFiles };
  },
};
