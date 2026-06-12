import path from "node:path";
import { fileExists, readIfExists } from "../core/fsutil.js";
import type { DetectedTechnology, GateId } from "../types.js";
import type { AdapterDetection, StackAdapter } from "./types.js";

export const goAdapter: StackAdapter = {
  id: "go",

  applies(root: string): boolean {
    return fileExists(path.join(root, "go.mod"));
  },

  detect(root: string): AdapterDetection {
    const goMod = readIfExists(path.join(root, "go.mod")) ?? "";
    const versionMatch = goMod.match(/^go\s+(\S+)/m);

    const technologies: DetectedTechnology[] = [
      {
        id: "go",
        name: "Go",
        kind: "language",
        version: versionMatch?.[1],
        evidence: ["go.mod"],
        confidence: 1,
      },
    ];

    const commands: Partial<Record<GateId, string>> = {
      lint: "go vet ./...",
      build: "go build ./...",
      test: "go test ./...",
      deps: "go mod verify",
      security: "govulncheck ./...",
    };

    const changedCommands: Partial<Record<GateId, string>> = {
      test: "go test {dirs}",
      lint: "go vet {dirs}",
    };

    const notableFiles = ["go.mod", "main.go", "Makefile"].filter((f) =>
      fileExists(path.join(root, f)),
    );

    return { technologies, commands, changedCommands, notableFiles };
  },
};
