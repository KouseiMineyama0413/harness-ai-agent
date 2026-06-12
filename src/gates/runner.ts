/**
 * Quality gate runner.
 *
 * Command resolution per gate (first hit wins):
 *   1. harness.yaml gates.<id>.command   (null = explicitly disabled)
 *   2. adapter-inferred command from the project profile
 *   3. otherwise the gate is skipped with a reason
 *
 * Gates run sequentially: their outputs interleave badly in parallel and
 * most toolchains (npm, pytest) contend on the same caches anyway.
 */
import { gateConfigFor, type HarnessConfig } from "../config/schema.js";
import { execCommand } from "../core/exec.js";
import type { Logger } from "../core/logger.js";
import { ALL_GATE_IDS, type GateId, type GateResult, type ProjectProfile, type ResolvedGate } from "../types.js";

export function resolveGates(
  config: HarnessConfig,
  profile: ProjectProfile,
  only?: GateId[],
): { resolved: ResolvedGate[]; skipped: GateResult[] } {
  const ids = only && only.length > 0 ? only : ALL_GATE_IDS;
  const resolved: ResolvedGate[] = [];
  const skipped: GateResult[] = [];

  for (const id of ids) {
    const gateCfg = gateConfigFor(config, id);

    if (gateCfg?.command === null) {
      skipped.push(skip(id, "disabled in harness.yaml"));
      continue;
    }
    const command = gateCfg?.command ?? profile.inferredCommands[id];
    if (!command) {
      skipped.push(skip(id, "no command configured or inferred"));
      continue;
    }
    resolved.push({
      id,
      command,
      source: gateCfg?.command ? "config" : "adapter",
      required: gateCfg?.required ?? defaultRequired(id),
      timeoutSec: gateCfg?.timeoutSec ?? 600,
    });
  }
  return { resolved, skipped };
}

/** security/deps/coverage are advisory by default; core gates are required. */
function defaultRequired(id: GateId): boolean {
  return !["security", "deps", "coverage"].includes(id);
}

function skip(id: GateId, reason: string): GateResult {
  return { id, status: "skipped", durationMs: 0, output: "", reason, required: false };
}

export async function runGates(
  root: string,
  config: HarnessConfig,
  profile: ProjectProfile,
  logger: Logger,
  only?: GateId[],
): Promise<GateResult[]> {
  const { resolved, skipped } = resolveGates(config, profile, only);
  const results: GateResult[] = [...skipped];

  for (const gate of resolved) {
    logger.info(`gate ${gate.id}: ${gate.command}`);
    const res = await execCommand(gate.command, { cwd: root, timeoutSec: gate.timeoutSec });

    let status: GateResult["status"];
    let reason: string | undefined;
    if (res.timedOut) {
      status = "timeout";
      reason = `exceeded ${gate.timeoutSec}s`;
    } else if (res.exitCode === null) {
      status = "error";
      reason = "command could not be started";
    } else if (res.exitCode === 0) {
      status = "passed";
    } else {
      status = "failed";
      reason = `exit code ${res.exitCode}`;
    }

    // Coverage threshold check: parse common "NN%" total lines from output.
    const coverageCfg = config.gates.coverage;
    if (gate.id === "coverage" && status === "passed" && coverageCfg?.threshold !== undefined) {
      const pct = parseCoverage(res.output);
      if (pct === null) {
        status = "error";
        reason = "could not parse coverage percentage from output";
      } else if (pct < coverageCfg.threshold) {
        status = "failed";
        reason = `coverage ${pct}% below threshold ${coverageCfg.threshold}%`;
      }
    }

    results.push({
      id: gate.id,
      status,
      command: gate.command,
      exitCode: res.exitCode ?? undefined,
      durationMs: res.durationMs,
      output: tail(res.output, 4000),
      reason,
      required: gate.required,
    });
    logger.info(`gate ${gate.id}: ${status}${reason ? ` (${reason})` : ""}`);
  }

  return results;
}

/** Extract a total coverage percentage from typical tool output. */
export function parseCoverage(output: string): number | null {
  // istanbul/vitest: "All files | 84.21 |", pytest-cov: "TOTAL ... 84%", go: "coverage: 84.2% of statements"
  const patterns = [
    /All files\s*\|\s*([\d.]+)/,
    /^TOTAL\s+.*?(\d+(?:\.\d+)?)%/m,
    /coverage:\s*([\d.]+)%/,
    /Lines\s*:\s*([\d.]+)%/,
  ];
  for (const p of patterns) {
    const m = output.match(p);
    if (m?.[1]) return Number.parseFloat(m[1]);
  }
  return null;
}

export function gatesPassed(results: GateResult[]): boolean {
  return results.every(
    (r) => !r.required || r.status === "passed" || r.status === "skipped",
  );
}

function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return "… [truncated]\n" + text.slice(-maxChars);
}
