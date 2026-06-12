/**
 * Requirement management: structured feature documents stored under
 * .harness/requirements/, plus an ambiguity linter that flags vague wording
 * and missing acceptance criteria before implementation starts.
 */
import fs from "node:fs";
import path from "node:path";
import { readJsonIfExists, writeJson } from "../core/fsutil.js";
import type { Requirement } from "../types.js";

export const REQUIREMENTS_DIR = ".harness/requirements";

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9぀-ヿ一-龯]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "requirement";
}

export function createRequirement(root: string, title: string): { req: Requirement; file: string } {
  const dir = path.join(root, REQUIREMENTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const existing = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const id = `REQ-${String(existing.length + 1).padStart(3, "0")}`;

  const req: Requirement = {
    schemaVersion: 1,
    id,
    title,
    status: "draft",
    createdAt: new Date().toISOString(),
    summary: "",
    userStories: [],
    acceptanceCriteria: [],
    nonFunctional: [],
    outOfScope: [],
    openQuestions: [],
  };

  const file = path.join(dir, `${id}-${slugify(title)}.json`);
  writeJson(file, req);
  return { req, file };
}

export interface AmbiguityFinding {
  severity: "error" | "warning";
  message: string;
}

// Vague terms that need quantification before an agent can implement safely.
const VAGUE_TERMS: { regex: RegExp; hint: string }[] = [
  { regex: /\b(fast|quick|performant|slow)\b/i, hint: "quantify: latency/throughput target" },
  { regex: /\b(many|some|several|a few|lots of)\b/i, hint: "quantify: how many?" },
  { regex: /\b(user[- ]?friendly|intuitive|simple|easy)\b/i, hint: "define measurable UX criteria" },
  { regex: /\b(secure|safe)\b(?!\s+(against|from))/i, hint: "specify threat model / standard" },
  { regex: /\b(scalable|robust|reliable)\b/i, hint: "quantify: load, error budget, SLO" },
  { regex: /\b(etc\.?|and so on)\b/i, hint: "enumerate the full list" },
  { regex: /適切に|いい感じに|柔軟に|など|高速|たくさん/, hint: "曖昧表現: 測定可能な基準に置き換える" },
  { regex: /\bshould\s+probably\b|\bmaybe\b|\bideally\b/i, hint: "decide: requirement or not?" },
];

export function lintRequirement(req: Requirement): AmbiguityFinding[] {
  const findings: AmbiguityFinding[] = [];

  if (req.acceptanceCriteria.length === 0) {
    findings.push({ severity: "error", message: "no acceptance criteria defined" });
  }
  if (req.summary.trim().length < 10) {
    findings.push({ severity: "error", message: "summary is empty or too short" });
  }
  if (req.nonFunctional.length === 0) {
    findings.push({
      severity: "warning",
      message: "no non-functional requirements (perf, security, a11y, ops) — state them or mark N/A",
    });
  }
  if (req.openQuestions.length > 0 && req.status !== "draft") {
    findings.push({
      severity: "error",
      message: `status is "${req.status}" but ${req.openQuestions.length} open question(s) remain`,
    });
  }

  const textFields: [string, string[]][] = [
    ["summary", [req.summary]],
    ["userStories", req.userStories],
    ["acceptanceCriteria", req.acceptanceCriteria],
  ];
  for (const [field, values] of textFields) {
    for (const value of values) {
      for (const term of VAGUE_TERMS) {
        const m = value.match(term.regex);
        if (m) {
          findings.push({
            severity: "warning",
            message: `${field}: vague term "${m[0]}" — ${term.hint}`,
          });
        }
      }
    }
  }

  // Acceptance criteria should be verifiable: look for Given/When/Then or a verb + observable outcome.
  for (const ac of req.acceptanceCriteria) {
    if (ac.trim().length < 15) {
      findings.push({ severity: "warning", message: `acceptance criterion too thin to verify: "${ac}"` });
    }
  }

  return findings;
}

export function loadRequirement(root: string, idOrFile: string): { req: Requirement; file: string } | null {
  // Accept either a path or a REQ-id.
  const direct = path.isAbsolute(idOrFile) ? idOrFile : path.join(root, idOrFile);
  if (fs.existsSync(direct) && direct.endsWith(".json")) {
    const req = readJsonIfExists<Requirement>(direct);
    return req ? { req, file: direct } : null;
  }
  const dir = path.join(root, REQUIREMENTS_DIR);
  try {
    const hit = fs.readdirSync(dir).find((f) => f.startsWith(idOrFile) && f.endsWith(".json"));
    if (!hit) return null;
    const file = path.join(dir, hit);
    const req = readJsonIfExists<Requirement>(file);
    return req ? { req, file } : null;
  } catch {
    return null;
  }
}

export function listRequirements(root: string): { id: string; title: string; status: string; file: string }[] {
  const dir = path.join(root, REQUIREMENTS_DIR);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => {
        const req = readJsonIfExists<Requirement>(path.join(dir, f));
        return req
          ? { id: req.id, title: req.title, status: req.status, file: path.join(REQUIREMENTS_DIR, f) }
          : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  } catch {
    return [];
  }
}
