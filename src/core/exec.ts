/**
 * Safe-ish command execution for quality gates.
 * Output is size-capped and secret-redacted before it leaves this module,
 * so nothing downstream (reports, agent context, logs) can leak credentials.
 */
import { spawn } from "node:child_process";
import { redactSecrets } from "../guardrails/secrets.js";

const MAX_OUTPUT_BYTES = 200_000;

export interface ExecResult {
  exitCode: number | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export async function execCommand(
  command: string,
  opts: { cwd: string; timeoutSec: number; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      shell: true,
      env: { ...process.env, ...opts.env, HARNESS: "1", CI: process.env.CI ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    const collect = (buf: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_OUTPUT_BYTES - bytes;
      chunks.push(buf.subarray(0, room));
      bytes += Math.min(buf.length, room);
      if (buf.length > room) truncated = true;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate if the process ignores SIGTERM.
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutSec * 1000);

    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      let output = Buffer.concat(chunks).toString("utf8");
      if (truncated) output += "\n… [output truncated by harness]";
      resolve({
        exitCode,
        output: redactSecrets(output),
        durationMs: Date.now() - start,
        timedOut,
      });
    };

    child.on("error", (err) => {
      chunks.push(Buffer.from(`harness exec error: ${err.message}\n`));
      finish(null);
    });
    child.on("close", (code) => finish(code));
  });
}
