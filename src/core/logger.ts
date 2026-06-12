/**
 * Minimal structured logger. Writes human-readable lines to stderr so that
 * stdout stays clean for machine-readable command output (JSON, etc.),
 * and appends JSONL entries to .harness/logs/harness.log for auditability.
 */
import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly logFile: string | null;

  constructor(opts: { root?: string; level?: LogLevel } = {}) {
    this.minLevel = opts.level ?? (process.env.HARNESS_LOG_LEVEL as LogLevel) ?? "info";
    this.logFile = opts.root ? path.join(opts.root, ".harness", "logs", "harness.log") : null;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const prefix = { debug: "·", info: "ℹ", warn: "⚠", error: "✖" }[level];
    process.stderr.write(`${prefix} ${msg}\n`);
    if (this.logFile) {
      try {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        const entry = { ts: new Date().toISOString(), level, msg, ...data };
        fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n", "utf8");
      } catch {
        // Logging must never crash the harness.
      }
    }
  }
}
