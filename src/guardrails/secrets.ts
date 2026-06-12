/**
 * Secret detection and redaction.
 * Used in two places:
 *  - redactSecrets(): scrub command output before it reaches reports/logs/agents
 *  - findSecrets(): scan diff/file content for credentials being introduced
 */

interface SecretPattern {
  kind: string;
  regex: RegExp;
}

// Patterns are deliberately specific (prefixed tokens, key blocks, assignments)
// to keep false positives manageable in real repos.
const PATTERNS: SecretPattern[] = [
  { kind: "aws-access-key", regex: /\b(A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g },
  { kind: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { kind: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "openai-key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "private-key-block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: "generic-assignment",
    regex: /\b(api[_-]?key|secret|password|passwd|token|credential)s?\b\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.]{12,}["']?/gi,
  },
  { kind: "connection-string", regex: /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/[^\s:@]+:[^\s@]+@[^\s]+/gi },
];

/** Replace anything that looks like a credential with a redaction marker. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.regex, `[REDACTED:${p.kind}]`);
  }
  return out;
}

export interface SecretFinding {
  line: number;
  kind: string;
}

/** Scan text content, returning the line numbers of suspected secrets. */
export function findSecrets(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Allow explicit opt-outs for test fixtures / docs.
    if (/harness-allow-secret/.test(line)) continue;
    for (const p of PATTERNS) {
      if (p.kind === "private-key-block") continue; // multi-line, handled below
      p.regex.lastIndex = 0;
      if (p.regex.test(line)) {
        findings.push({ line: i + 1, kind: p.kind });
        break; // one finding per line is enough
      }
    }
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
    const idx = lines.findIndex((l) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(l));
    findings.push({ line: idx + 1, kind: "private-key-block" });
  }
  return findings;
}
