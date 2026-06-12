/**
 * Cross-cutting detection for infrastructure and ops tooling.
 * This adapter never infers gate commands — running terraform/kubectl is
 * exactly the kind of thing the harness should leave to explicit config.
 */
import path from "node:path";
import fs from "node:fs";
import { fileExists, readIfExists } from "../core/fsutil.js";
import type { DetectedTechnology } from "../types.js";
import type { AdapterDetection, StackAdapter } from "./types.js";

function hasFileWithExt(root: string, ext: string): boolean {
  try {
    return fs.readdirSync(root).some((f) => f.endsWith(ext));
  } catch {
    return false;
  }
}

export const infraAdapter: StackAdapter = {
  id: "infra",

  applies(): boolean {
    return true; // cheap checks happen inside detect()
  },

  detect(root: string): AdapterDetection {
    const technologies: DetectedTechnology[] = [];
    const notableFiles: string[] = [];

    if (fileExists(path.join(root, "Dockerfile"))) {
      technologies.push({
        id: "docker",
        name: "Docker",
        kind: "infra",
        evidence: ["Dockerfile"],
        confidence: 1,
      });
      notableFiles.push("Dockerfile");
    }
    for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yaml"]) {
      if (fileExists(path.join(root, f))) {
        technologies.push({
          id: "docker-compose",
          name: "Docker Compose",
          kind: "infra",
          evidence: [f],
          confidence: 1,
        });
        notableFiles.push(f);
        break;
      }
    }
    if (hasFileWithExt(root, ".tf") || fileExists(path.join(root, "terraform"))) {
      technologies.push({
        id: "terraform",
        name: "Terraform",
        kind: "infra",
        evidence: ["*.tf"],
        confidence: 0.9,
      });
    }
    if (
      fileExists(path.join(root, "k8s")) ||
      fileExists(path.join(root, "kustomization.yaml")) ||
      fileExists(path.join(root, "helm"))
    ) {
      technologies.push({
        id: "kubernetes",
        name: "Kubernetes",
        kind: "infra",
        evidence: ["k8s/ or kustomization.yaml or helm/"],
        confidence: 0.8,
      });
    }
    if (fileExists(path.join(root, ".github", "workflows"))) {
      technologies.push({
        id: "github-actions",
        name: "GitHub Actions",
        kind: "tooling",
        evidence: [".github/workflows/"],
        confidence: 1,
      });
    }

    // Database hints from compose files / env examples.
    const composeText =
      readIfExists(path.join(root, "docker-compose.yml")) ??
      readIfExists(path.join(root, "compose.yaml")) ??
      "";
    const envExample = readIfExists(path.join(root, ".env.example")) ?? "";
    const hints = composeText + "\n" + envExample;
    for (const db of [
      { needle: /postgres/i, id: "postgres", name: "PostgreSQL" },
      { needle: /mysql|mariadb/i, id: "mysql", name: "MySQL/MariaDB" },
      { needle: /mongo/i, id: "mongodb", name: "MongoDB" },
      { needle: /redis/i, id: "redis", name: "Redis" },
    ]) {
      if (db.needle.test(hints)) {
        technologies.push({
          id: db.id,
          name: db.name,
          kind: "database",
          evidence: ["docker-compose / .env.example"],
          confidence: 0.7,
        });
      }
    }

    return { technologies, commands: {}, notableFiles };
  },
};
