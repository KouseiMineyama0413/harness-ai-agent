/**
 * Doc-source collection: gather the small set of files that describe a
 * service's shape (manifests, entry points, routes, schemas, infra) so the
 * LLM can write docs without reading the whole repository.
 * Everything is size-capped — large repos must still produce small prompts.
 */
import fs from "node:fs";
import path from "node:path";
import { readIfExists } from "../core/fsutil.js";
import type { ProjectProfile } from "../types.js";

const PER_FILE_CAP = 8_000;
const TOTAL_CAP = 64_000;

export interface DocSource {
  /** Repo-relative path. */
  path: string;
  /** Truncated content. */
  content: string;
}

/** Well-known files that describe a service, beyond what adapters flagged. */
const CANDIDATE_FILES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "Dockerfile",
  "docker-compose.yml",
  "compose.yaml",
  ".env.example",
  "openapi.yaml",
  "openapi.json",
  "prisma/schema.prisma",
  "harness.yaml",
];

/** Glob-free entry-point candidates per ecosystem convention. */
const ENTRY_CANDIDATES = [
  "src/index.ts",
  "src/index.js",
  "src/main.ts",
  "src/main.py",
  "src/cli.ts",
  "src/app.ts",
  "app/main.py",
  "main.go",
  "cmd",
  "manage.py",
  "app.py",
];

/** Directories whose file LISTING (not content) helps the doc writer. */
const LISTING_DIRS = ["migrations", "db/migrate", "src/routes", "app/api", "src/controllers"];

function truncate(content: string): string {
  if (content.length <= PER_FILE_CAP) return content;
  return content.slice(0, PER_FILE_CAP) + "\n… [truncated]";
}

function listDir(root: string, rel: string): string | null {
  const abs = path.join(root, rel);
  try {
    const entries = fs.readdirSync(abs).slice(0, 60);
    return entries.join("\n");
  } catch {
    return null;
  }
}

export function collectDocSources(root: string, profile: ProjectProfile): DocSource[] {
  const sources: DocSource[] = [];
  const seen = new Set<string>();
  let total = 0;

  const add = (rel: string, content: string) => {
    if (seen.has(rel) || total >= TOTAL_CAP) return;
    const body = truncate(content);
    if (total + body.length > TOTAL_CAP) return;
    seen.add(rel);
    total += body.length;
    sources.push({ path: rel, content: body });
  };

  // Layout overview is always first — cheapest, highest-signal context.
  const layout = Object.entries(profile.layout)
    .map(([dir, desc]) => `${dir}${desc ? ` — ${desc}` : ""}`)
    .join("\n");
  add("(top-level layout)", layout || "(flat repository)");

  for (const rel of [...CANDIDATE_FILES, ...profile.notableFiles, ...ENTRY_CANDIDATES]) {
    const abs = path.join(root, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        const listing = listDir(root, rel);
        if (listing) add(`${rel}/ (listing)`, listing);
        continue;
      }
      if (stat.size > 512_000) continue; // never read huge files
    } catch {
      continue;
    }
    const content = readIfExists(abs);
    if (content) add(rel, content);
  }

  for (const dir of LISTING_DIRS) {
    const listing = listDir(root, dir);
    if (listing) add(`${dir}/ (listing)`, listing);
  }

  return sources;
}

export function renderSources(sources: DocSource[]): string {
  return sources.map((s) => `=== ${s.path} ===\n${s.content}`).join("\n\n");
}
