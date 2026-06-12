/**
 * Report writer: persists every harness run as Markdown + JSON under
 * report.dir (default .harness/reports/), named <timestamp>-<kind>.{md,json}.
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessConfig } from "../config/schema.js";
import { writeJson, writeText } from "../core/fsutil.js";
import type { GateResult, RunReport } from "../types.js";

export function buildGateReport(
  projectName: string,
  gates: GateResult[],
  passed: boolean,
): RunReport {
  const failed = gates.filter((g) => g.status !== "passed" && g.status !== "skipped");
  const unresolvedRisks = failed
    .filter((g) => !g.required)
    .map((g) => `optional gate ${g.id} is ${g.status}${g.reason ? `: ${g.reason}` : ""}`);
  const nextSteps = failed
    .filter((g) => g.required)
    .map((g) => `fix required gate ${g.id} (${g.reason ?? g.status}) and re-run \`harness gate run --only ${g.id}\``);

  return {
    schemaVersion: 1,
    kind: "gate",
    generatedAt: new Date().toISOString(),
    project: projectName,
    summary: passed
      ? `All required gates passed (${gates.filter((g) => g.status === "passed").length} passed, ${gates.filter((g) => g.status === "skipped").length} skipped).`
      : `Required gates failing: ${failed.filter((g) => g.required).map((g) => g.id).join(", ") || "(none)"}.`,
    passed,
    gates,
    unresolvedRisks,
    nextSteps,
  };
}

export function writeReport(root: string, config: HarnessConfig, report: RunReport): string[] {
  const dir = path.join(root, config.report.dir);
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const base = path.join(dir, `${stamp}-${report.kind}`);
  const written: string[] = [];

  if (config.report.formats.includes("json")) {
    writeJson(`${base}.json`, report);
    written.push(`${base}.json`);
  }
  if (config.report.formats.includes("md")) {
    writeText(`${base}.md`, renderMarkdown(report));
    written.push(`${base}.md`);
  }
  return written;
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Harness ${report.kind} report — ${report.project}`);
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Result: ${report.passed ? "✅ PASSED" : "❌ FAILED"}`);
  lines.push("");
  lines.push(`> ${report.summary}`);
  lines.push("");

  if (report.gates) {
    lines.push("## Gates");
    lines.push("");
    lines.push("| Gate | Status | Required | Duration | Detail |");
    lines.push("|------|--------|----------|----------|--------|");
    for (const g of report.gates) {
      const icon = { passed: "✅", failed: "❌", skipped: "⏭", error: "💥", timeout: "⏱" }[g.status];
      lines.push(
        `| ${g.id} | ${icon} ${g.status} | ${g.required ? "yes" : "no"} | ${(g.durationMs / 1000).toFixed(1)}s | ${g.reason ?? ""} |`,
      );
    }
    lines.push("");
    for (const g of report.gates) {
      if ((g.status === "failed" || g.status === "error" || g.status === "timeout") && g.output) {
        lines.push(`### ${g.id} output (\`${g.command}\`)`);
        lines.push("");
        lines.push("```");
        lines.push(g.output.trim());
        lines.push("```");
        lines.push("");
      }
    }
  }

  if (report.unresolvedRisks.length > 0) {
    lines.push("## Unresolved risks");
    for (const r of report.unresolvedRisks) lines.push(`- ${r}`);
    lines.push("");
  }
  if (report.nextSteps.length > 0) {
    lines.push("## Next steps");
    for (const s of report.nextSteps) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function listReports(root: string, config: HarnessConfig): string[] {
  const dir = path.join(root, config.report.dir);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".md") || f.endsWith(".json"))
      .sort()
      .map((f) => path.join(config.report.dir, f));
  } catch {
    return [];
  }
}
