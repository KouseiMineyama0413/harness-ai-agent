import path from "node:path";
import { fileExists, readIfExists } from "../core/fsutil.js";
import type { DetectedTechnology, GateId } from "../types.js";
import type { AdapterDetection, StackAdapter } from "./types.js";

const MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];

const FRAMEWORKS: { needle: RegExp; id: string; name: string }[] = [
  { needle: /\bfastapi\b/i, id: "fastapi", name: "FastAPI" },
  { needle: /\bdjango\b/i, id: "django", name: "Django" },
  { needle: /\bflask\b/i, id: "flask", name: "Flask" },
];

export const pythonAdapter: StackAdapter = {
  id: "python",

  applies(root: string): boolean {
    return MARKERS.some((m) => fileExists(path.join(root, m)));
  },

  detect(root: string): AdapterDetection {
    const evidence = MARKERS.filter((m) => fileExists(path.join(root, m)));
    // Naive but effective: search dependency declarations as text. A full
    // TOML parser is a future improvement, not needed for detection.
    const depText = [
      readIfExists(path.join(root, "pyproject.toml")),
      readIfExists(path.join(root, "requirements.txt")),
      readIfExists(path.join(root, "Pipfile")),
    ]
      .filter((t): t is string => t !== null)
      .join("\n");

    const technologies: DetectedTechnology[] = [
      { id: "python", name: "Python", kind: "language", evidence, confidence: 1 },
    ];
    for (const fw of FRAMEWORKS) {
      if (fw.needle.test(depText)) {
        technologies.push({
          id: fw.id,
          name: fw.name,
          kind: "framework",
          evidence,
          confidence: 0.85,
        });
      }
    }

    const usesPoetry = /\[tool\.poetry\]/.test(depText);
    const usesUv = fileExists(path.join(root, "uv.lock"));
    const prefix = usesUv ? "uv run " : usesPoetry ? "poetry run " : "";

    const commands: Partial<Record<GateId, string>> = {};
    if (/\bruff\b/.test(depText)) commands.lint = `${prefix}ruff check .`;
    else if (/\bflake8\b/.test(depText)) commands.lint = `${prefix}flake8`;
    if (/\bmypy\b/.test(depText)) commands.typecheck = `${prefix}mypy .`;
    else if (/\bpyright\b/.test(depText)) commands.typecheck = `${prefix}pyright`;
    if (/\bpytest\b/.test(depText)) commands.test = `${prefix}pytest -q`;
    if (/\bdjango\b/i.test(depText) && !commands.test) commands.test = `${prefix}python manage.py test`;
    commands.deps = "pip audit || pip-audit";
    if (/\bbandit\b/.test(depText)) commands.security = `${prefix}bandit -r .`;

    const notableFiles = [...evidence, "manage.py", "alembic.ini"].filter((f) =>
      fileExists(path.join(root, f)),
    );

    return { technologies, commands, notableFiles };
  },
};
