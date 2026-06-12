/**
 * Claude Code CLI provider.
 *
 * Uses the locally logged-in Claude Code session (`claude -p`, headless
 * print mode) instead of an API key — completions are billed to whatever
 * auth the developer's Claude Code already uses. Ideal for local use;
 * CI should use the `anthropic` provider with a real key.
 *
 * Notes: max_tokens is not controllable through the CLI and is ignored;
 * the model can be overridden via llm.model (passed as --model).
 */
import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import type { HarnessConfig } from "../config/schema.js";
import type { CompletionRequest, LlmProvider } from "./provider.js";

const TIMEOUT_MS = 600_000;

/** Binary resolution: env override > harness.yaml llm.claudeBin > PATH. */
export function claudeBin(config?: HarnessConfig["llm"]): string {
  return process.env.HARNESS_CLAUDE_BIN ?? config?.claudeBin ?? "claude";
}

export function claudeCliAvailable(config?: HarnessConfig["llm"]): boolean {
  try {
    return (
      spawnSync(claudeBin(config), ["--version"], { stdio: "ignore", timeout: 10_000 }).status === 0
    );
  } catch {
    return false;
  }
}

export const claudeCliProvider: LlmProvider = {
  id: "claude-cli",

  async complete(req: CompletionRequest, config: HarnessConfig["llm"]): Promise<string> {
    const args = ["-p", "--output-format", "text"];
    if (req.system) args.push("--append-system-prompt", req.system);
    if (config.model) args.push("--model", config.model);

    return new Promise((resolve, reject) => {
      const child = spawn(claudeBin(config), args, { stdio: ["pipe", "pipe", "pipe"] });

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (b: Buffer) => out.push(b));
      child.stderr.on("data", (b: Buffer) => err.push(b));

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`claude CLI timed out after ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);

      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`could not start claude CLI: ${e.message} — is Claude Code installed?`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const text = Buffer.concat(out).toString("utf8").trim();
        if (code !== 0) {
          reject(
            new Error(
              `claude CLI exited with code ${code}: ${Buffer.concat(err).toString("utf8").trim().slice(0, 500)}`,
            ),
          );
        } else if (!text) {
          reject(new Error("claude CLI returned no output"));
        } else {
          resolve(text);
        }
      });

      // Prompt goes via stdin to avoid ARG_MAX limits on large doc sources.
      child.stdin.write(req.prompt);
      child.stdin.end();
    });
  },
};
