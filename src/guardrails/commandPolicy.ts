/**
 * Shell command safety policy for AI agents.
 *
 * Verdicts:
 *  - deny:    never run automatically (irreversible / destructive / privileged)
 *  - confirm: requires explicit human approval (risky but sometimes legitimate)
 *  - allow:   no rule matched
 *
 * Project config can extend the deny list (agent.deniedCommands) and
 * allowlist exact known-safe commands (agent.allowedCommands).
 */
import type { CommandVerdict } from "../types.js";

interface PolicyRule {
  level: "deny" | "confirm";
  regex: RegExp;
  reason: string;
}

const RULES: PolicyRule[] = [
  // --- deny: irreversible or system-level destruction ---
  { level: "deny", regex: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|\$HOME|\.\s*$)/, reason: "recursive force-delete of root/home/cwd" },
  { level: "deny", regex: /\bmkfs(\.\w+)?\b/, reason: "filesystem format" },
  { level: "deny", regex: /\bdd\s+[^|;]*of=\/dev\//, reason: "raw write to block device" },
  { level: "deny", regex: /:\(\)\s*\{\s*:\|\s*:\s*&\s*\}\s*;/, reason: "fork bomb" },
  { level: "deny", regex: /\bgit\s+push\b[^|;&]*(--force|-f)\b[^|;&]*\b(main|master|production|release)\b/, reason: "force push to protected branch" },
  { level: "deny", regex: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/, reason: "pipe remote script to shell" },
  { level: "deny", regex: /\bchmod\s+(-R\s+)?777\b/, reason: "world-writable permissions" },
  { level: "deny", regex: /\bDROP\s+(DATABASE|SCHEMA)\b/i, reason: "drop database/schema" },

  // --- confirm: legitimate but needs a human in the loop ---
  { level: "confirm", regex: /\bsudo\b/, reason: "privileged execution" },
  { level: "confirm", regex: /\bgit\s+push\b[^|;&]*(--force|-f)\b/, reason: "force push" },
  { level: "confirm", regex: /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s)/, reason: "discards local changes" },
  { level: "confirm", regex: /\bgit\s+(rebase|filter-branch|filter-repo)\b/, reason: "history rewrite" },
  { level: "confirm", regex: /\brm\s+-[a-zA-Z]*r/, reason: "recursive delete" },
  { level: "confirm", regex: /\bterraform\s+(apply|destroy)\b/, reason: "infrastructure mutation" },
  { level: "confirm", regex: /\bkubectl\s+(delete|drain|cordon)\b/, reason: "cluster mutation" },
  { level: "confirm", regex: /\bhelm\s+(uninstall|delete|rollback)\b/, reason: "cluster mutation" },
  { level: "confirm", regex: /\baws\s+\w*\s*(delete|terminate|rb)\b/, reason: "cloud resource deletion" },
  { level: "confirm", regex: /\bgcloud\b[^|;&]*\bdelete\b/, reason: "cloud resource deletion" },
  { level: "confirm", regex: /\baz\b[^|;&]*\bdelete\b/, reason: "cloud resource deletion" },
  { level: "confirm", regex: /\bdocker\s+(system|volume|image|container)\s+prune\b/, reason: "bulk docker cleanup" },
  { level: "confirm", regex: /\bDROP\s+TABLE\b/i, reason: "drop table" },
  { level: "confirm", regex: /\bTRUNCATE\b/i, reason: "truncate table" },
  { level: "confirm", regex: /\bDELETE\s+FROM\b(?![^;]*\bWHERE\b)/i, reason: "unscoped SQL delete" },
  { level: "confirm", regex: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/, reason: "package publish" },
  { level: "confirm", regex: />\s*\/etc\//, reason: "writes to /etc" },
];

export interface PolicyOptions {
  /** Extra deny patterns from harness.yaml (regex strings). */
  extraDenied?: string[];
  /** Exact-match or regex allowlist that short-circuits to allow. */
  allowed?: string[];
}

export function checkCommand(command: string, opts: PolicyOptions = {}): CommandVerdict {
  const trimmed = command.trim();

  for (const pattern of opts.allowed ?? []) {
    try {
      if (trimmed === pattern || new RegExp(pattern).test(trimmed)) {
        return { command: trimmed, verdict: "allow", reasons: [`allowlisted: ${pattern}`] };
      }
    } catch {
      // Invalid user regex: ignore the allowlist entry rather than crash.
    }
  }

  const reasons: string[] = [];
  let verdict: CommandVerdict["verdict"] = "allow";

  for (const pattern of opts.extraDenied ?? []) {
    try {
      if (new RegExp(pattern).test(trimmed)) {
        verdict = "deny";
        reasons.push(`project deny rule: ${pattern}`);
      }
    } catch {
      reasons.push(`invalid project deny pattern (ignored): ${pattern}`);
    }
  }

  for (const rule of RULES) {
    if (rule.regex.test(trimmed)) {
      if (rule.level === "deny") {
        verdict = "deny";
        reasons.push(rule.reason);
      } else if (verdict !== "deny") {
        verdict = "confirm";
        reasons.push(rule.reason);
      } else {
        reasons.push(rule.reason);
      }
    }
  }

  return { command: trimmed, verdict, reasons };
}
