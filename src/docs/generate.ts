/**
 * Documentation generation for under-documented services.
 *
 * Pipeline: collect doc sources (size-capped) -> one LLM call per doc type
 * -> write to docs/ with an AUTO-GENERATED header. Human-written docs are
 * never overwritten (only files carrying our header are, and only with
 * --force semantics handled by the caller via the `force` flag).
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { readIfExists, writeText } from "../core/fsutil.js";
import { generatedFileHeader, isGeneratedFile } from "../core/markers.js";
import { resolveProvider } from "../llm/provider.js";
import type { ProjectProfile } from "../types.js";
import { collectDocSources, renderSources } from "./sources.js";

export const DOC_TYPES = ["architecture", "api", "onboarding"] as const;
export type DocType = (typeof DOC_TYPES)[number];

const DOC_PROMPTS: Record<DocType, { file: string; instruction: string }> = {
  architecture: {
    file: "docs/architecture.md",
    instruction:
      "Write an architecture overview: what the service does, the main components/modules and " +
      "their responsibilities, how data flows between them, external dependencies (DBs, queues, " +
      "third-party APIs), and where to start reading the code. Include a simple ASCII diagram if helpful.",
  },
  api: {
    file: "docs/api.md",
    instruction:
      "Document the service's external interface: HTTP endpoints / CLI commands / public functions " +
      "visible in the sources, with method, path/name, purpose, and notable request/response shapes. " +
      "If the sources do not show a clear external interface, document what IS visible and list " +
      "what a maintainer should fill in.",
  },
  onboarding: {
    file: "docs/onboarding.md",
    instruction:
      "Write an onboarding guide for a new engineer: prerequisites (runtime versions, tools), " +
      "setup steps (install, env vars from .env.example, DB/migrations), how to run the service " +
      "locally, how to run tests/lint/build, and the typical development workflow.",
  },
};

const SYSTEM_PROMPT = [
  "You write engineering documentation from source-file excerpts.",
  "Ground every statement in the provided sources; when something is unknown, write 'TODO (confirm):' rather than inventing it.",
  "Write in the same language as the repository's README when one exists; otherwise write in English.",
  "Output pure Markdown for the requested document only — no preamble.",
].join("\n");

export interface DocGenResult {
  type: DocType;
  file: string;
  action: "written" | "skipped-human-file" | "skipped-exists";
}

export async function generateDocs(
  root: string,
  config: HarnessConfig,
  profile: ProjectProfile,
  opts: { only?: DocType[]; force?: boolean } = {},
): Promise<DocGenResult[]> {
  const types = opts.only && opts.only.length > 0 ? opts.only : [...DOC_TYPES];
  const sources = collectDocSources(root, profile);
  const sourceBlock = renderSources(sources);
  const provider = resolveProvider(config.llm);
  const maxTokens = Math.max(config.llm.maxTokens, 8000);

  const results: DocGenResult[] = [];
  for (const type of types) {
    const spec = DOC_PROMPTS[type];
    const target = path.join(root, spec.file);
    const existing = readIfExists(target);

    if (existing !== null && !isGeneratedFile(existing)) {
      // A human wrote this — never touch it, even with --force.
      results.push({ type, file: spec.file, action: "skipped-human-file" });
      continue;
    }
    if (existing !== null && !opts.force) {
      results.push({ type, file: spec.file, action: "skipped-exists" });
      continue;
    }

    const body = await provider.complete(
      {
        system: SYSTEM_PROMPT,
        prompt:
          `Project: ${config.project.name}` +
          (config.project.description ? ` — ${config.project.description}` : "") +
          `\nTechnologies: ${profile.technologies.map((t) => t.name).join(", ")}` +
          `\n\nTask: ${spec.instruction}` +
          `\n\nSource excerpts:\n\n${sourceBlock}`,
        maxTokens,
      },
      config.llm,
    );

    writeText(
      target,
      `${generatedFileHeader("harness docs generate")}\n\n${body.trim()}\n`,
    );
    results.push({ type, file: spec.file, action: "written" });
  }
  return results;
}

export interface DocCheckFinding {
  file: string;
  status: "missing" | "stale" | "ok";
  detail: string;
}

/** Newest mtime of source-ish files, bounded to keep the scan cheap. */
function newestSourceMtime(root: string): number {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "docs", ".harness", "vendor", ".venv", "__pycache__", ".next"]);
  let newest = 0;
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || visited > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      visited++;
      if (e.isDirectory()) walk(abs, depth + 1);
      else {
        try {
          const m = fs.statSync(abs).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          // ignore
        }
      }
    }
  };
  walk(root, 0);
  return newest;
}

const STALE_DAYS = 30;

export function checkDocs(root: string): DocCheckFinding[] {
  const findings: DocCheckFinding[] = [];
  const sourceMtime = newestSourceMtime(root);
  const targets = ["README.md", ...DOC_TYPES.map((t) => DOC_PROMPTS[t].file)];

  for (const rel of targets) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      findings.push({
        file: rel,
        status: "missing",
        detail: rel === "README.md" ? "no README" : "generate with `harness docs generate`",
      });
      continue;
    }
    const docMtime = fs.statSync(abs).mtimeMs;
    const lagDays = (sourceMtime - docMtime) / 86_400_000;
    if (lagDays > STALE_DAYS) {
      findings.push({
        file: rel,
        status: "stale",
        detail: `code changed ${Math.floor(lagDays)} days after this doc was last touched`,
      });
    } else {
      findings.push({ file: rel, status: "ok", detail: "up to date" });
    }
  }
  return findings;
}
