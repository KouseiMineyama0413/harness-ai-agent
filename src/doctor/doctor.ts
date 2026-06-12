/**
 * Environment diagnosis: everything a new team member (or a fresh agent
 * environment) needs verified before the harness can do its job.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadProfile } from "../analyze/analyzer.js";
import { ConfigError, loadConfig } from "../config/load.js";
import { fileExists } from "../core/fsutil.js";
import { resolveGates } from "../gates/runner.js";
import { listClaims } from "../guardrails/claims.js";
import { isClaudeHookInstalled } from "../integrations/install.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const STALE_PROFILE_DAYS = 14;
const STALE_CLAIM_HOURS = 24;

export async function runDoctor(root: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorCheck["status"], detail: string) =>
    checks.push({ name, status, detail });

  // Node version
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major! > 22 || (major === 22 && minor! >= 5)) {
    add("node", "ok", `v${process.versions.node}`);
  } else {
    add("node", "fail", `v${process.versions.node} — harness requires >= 22.5`);
  }

  // node:sqlite
  try {
    const mod = process.getBuiltinModule?.("node:sqlite") ?? (await import("node:sqlite"));
    add("node:sqlite", mod ? "ok" : "fail", mod ? "available" : "missing");
  } catch {
    add("node:sqlite", "fail", "unavailable — team/search/reindex commands will not work");
  }

  // git
  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    add("git", "ok", version);
    try {
      execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
      add("git repo", "ok", "inside a work tree");
    } catch {
      add("git repo", "warn", "not a git repository — guard scan-diff and pr-summary need git");
    }
  } catch {
    add("git", "fail", "git not found on PATH");
  }

  // config
  let config;
  try {
    const loaded = loadConfig(root);
    config = loaded.config;
    add(
      "harness.yaml",
      loaded.source ? "ok" : "warn",
      loaded.source ? "valid" : "not found — using defaults (run `harness init`)",
    );
  } catch (err) {
    add("harness.yaml", "fail", err instanceof ConfigError ? err.message.split("\n")[0]! : String(err));
  }

  // profile
  const profile = loadProfile(root);
  if (!profile) {
    add("project profile", "warn", "missing — run `harness analyze`");
  } else {
    const ageDays = (Date.now() - Date.parse(profile.generatedAt)) / 86_400_000;
    add(
      "project profile",
      ageDays > STALE_PROFILE_DAYS ? "warn" : "ok",
      ageDays > STALE_PROFILE_DAYS
        ? `stale (${Math.floor(ageDays)} days old) — re-run \`harness analyze\``
        : `generated ${profile.generatedAt}`,
    );
  }

  // gates resolvable
  if (config && profile) {
    const { resolved, skipped } = resolveGates(config, profile);
    add(
      "gates",
      resolved.length > 0 ? "ok" : "warn",
      `${resolved.length} runnable, ${skipped.length} skipped (${skipped.map((s) => s.id).join(", ") || "none"})`,
    );
  }

  // stale claims
  const claims = listClaims(root);
  const stale = claims.filter(
    (c) => Date.now() - Date.parse(c.claimedAt) > STALE_CLAIM_HOURS * 3_600_000,
  );
  if (claims.length === 0) {
    add("claims", "ok", "no active claims");
  } else {
    add(
      "claims",
      stale.length > 0 ? "warn" : "ok",
      stale.length > 0
        ? `${stale.length}/${claims.length} older than ${STALE_CLAIM_HOURS}h: ${stale.map((c) => `${c.path} (${c.agent})`).join(", ")}`
        : `${claims.length} active`,
    );
  }

  // agent integrations
  add(
    "claude integration",
    isClaudeHookInstalled(root) ? "ok" : "warn",
    isClaudeHookInstalled(root)
      ? "UserPromptSubmit hook installed"
      : "not installed — run `harness integrate claude`",
  );
  add(
    "codex integration",
    fileExists(path.join(root, "AGENTS.md")) ? "ok" : "warn",
    fileExists(path.join(root, "AGENTS.md"))
      ? "AGENTS.md present"
      : "no AGENTS.md — run `harness integrate codex`",
  );

  return checks;
}
