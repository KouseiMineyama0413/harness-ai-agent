/**
 * Heuristic error classification for tool outputs.
 *
 * First match wins. These patterns are deliberately conservative: a missed
 * classification just falls back to "other" / "non_zero_exit", which is fine —
 * the LLM still sees the raw preview and can reason about it. The point of
 * classification is to let the digest group repeat failures cheaply.
 */
import type { ErrorCategory } from "./types.js";

const PATTERNS: Array<[RegExp, ErrorCategory]> = [
  [/no such file or directory|enoent|file not found|fileNotFoundError/i, "file_not_found"],
  [/module not found|cannot find module|modulenotfounderror|cannot find package/i, "module_not_found"],
  [/command not found|not recognized as an internal|: not found/i, "command_not_found"],
  [/permission denied|eacces|operation not permitted/i, "permission_denied"],
  [/syntaxerror|parse error|unexpected token|expected .* but found/i, "syntax_error"],
  [/typeerror|ts\d{3,5}:|type '.*' is not assignable/i, "type_error"],
  [/\b\d+ (?:failed|failing)\b|test(?:s)? failed|assertionerror|expect\(.*\)/i, "test_failure"],
  [/timed out|timeout|etimedout|deadline exceeded/i, "timeout"],
  [/econnrefused|enotfound|network error|getaddrinfo|connection refused/i, "network"],
  [/merge conflict|conflict marker|<<<<<<< |both modified/i, "git_conflict"],
];

/**
 * Detect whether tool-result content looks like an error, even when the agent
 * did not flag is_error (e.g. a Bash command that printed an error but the
 * wrapper reported success). Scans only the leading window for speed.
 */
export function looksLikeError(content: string): boolean {
  const head = content.slice(0, 1024).toLowerCase();
  return (
    head.includes("error") ||
    head.includes("traceback") ||
    head.includes("exception") ||
    head.includes("enoent") ||
    head.includes("command not found") ||
    head.includes("permission denied") ||
    head.includes("fatal:") ||
    /\bfailed\b/.test(head)
  );
}

/** Map error content to a coarse category. */
export function classifyError(content: string): ErrorCategory {
  const head = content.slice(0, 2048);
  for (const [re, cat] of PATTERNS) {
    if (re.test(head)) return cat;
  }
  if (/exit code [1-9]|exited with|non-zero/i.test(head)) return "non_zero_exit";
  return "other";
}
