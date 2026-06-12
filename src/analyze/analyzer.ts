/**
 * Project analyzer: runs all applicable adapters, merges their detections,
 * and persists the result as .harness/project_profile.json.
 *
 * The profile is the harness's long-term memory about a repository. The
 * `notes` array is preserved across re-analysis so humans/agents can append
 * knowledge that detection cannot derive.
 */
import path from "node:path";
import { getAdapters } from "../adapters/registry.js";
import type { HarnessConfig } from "../config/schema.js";
import { listTopLevelDirs, readJsonIfExists, writeJson } from "../core/fsutil.js";
import type { Logger } from "../core/logger.js";
import type { DetectedTechnology, GateId, ProjectProfile } from "../types.js";

export const PROFILE_PATH = ".harness/project_profile.json";

const DIR_HINTS: Record<string, string> = {
  src: "application source",
  app: "application source",
  lib: "library code",
  test: "tests",
  tests: "tests",
  spec: "tests",
  e2e: "end-to-end tests",
  docs: "documentation",
  scripts: "dev/ops scripts",
  migrations: "database migrations",
  infra: "infrastructure as code",
  terraform: "infrastructure as code",
  k8s: "kubernetes manifests",
  config: "configuration",
  public: "static assets",
  api: "API layer",
  cmd: "entry points (Go convention)",
  internal: "internal packages (Go convention)",
};

export function analyzeProject(root: string, config: HarnessConfig, logger: Logger): ProjectProfile {
  const technologies: DetectedTechnology[] = [];
  const inferredCommands: Partial<Record<GateId, string>> = {};
  const notableFiles = new Set<string>();

  for (const adapter of getAdapters()) {
    if (!adapter.applies(root)) continue;
    logger.debug(`adapter ${adapter.id}: detecting`);
    try {
      const result = adapter.detect(root);
      technologies.push(...result.technologies);
      for (const [gate, cmd] of Object.entries(result.commands)) {
        // First adapter to claim a gate wins (registry order is priority).
        if (cmd && !inferredCommands[gate as GateId]) {
          inferredCommands[gate as GateId] = cmd;
        }
      }
      result.notableFiles.forEach((f) => notableFiles.add(f));
    } catch (err) {
      logger.warn(`adapter ${adapter.id} failed: ${(err as Error).message}`);
    }
  }

  // Manual stack hints from config, marked as such.
  for (const stack of config.stacks) {
    if (!technologies.some((t) => t.id === stack)) {
      technologies.push({
        id: stack,
        name: stack,
        kind: "tooling",
        evidence: ["harness.yaml: stacks"],
        confidence: 1,
      });
    }
  }

  const layout: Record<string, string> = {};
  for (const dir of listTopLevelDirs(root)) {
    layout[dir + "/"] = DIR_HINTS[dir] ?? "";
  }

  const previous = readJsonIfExists<ProjectProfile>(path.join(root, PROFILE_PATH));

  const profile: ProjectProfile = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    name: config.project.name,
    technologies,
    inferredCommands,
    layout,
    notableFiles: [...notableFiles].sort(),
    notes: previous?.notes ?? [],
  };

  writeJson(path.join(root, PROFILE_PATH), profile);
  logger.info(`profile written to ${PROFILE_PATH}`, {
    technologies: technologies.map((t) => t.id),
  });
  return profile;
}

export function loadProfile(root: string): ProjectProfile | null {
  return readJsonIfExists<ProjectProfile>(path.join(root, PROFILE_PATH));
}
