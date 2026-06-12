/**
 * Public programmatic API. The CLI is a thin layer over these exports, so
 * other tools (CI plugins, MCP servers, editor extensions) can embed the
 * harness without shelling out.
 */
export * from "./types.js";
export { harnessConfigSchema, defaultConfig, type HarnessConfig } from "./config/schema.js";
export { loadConfig, ConfigError, CONFIG_FILENAME } from "./config/load.js";
export { analyzeProject, loadProfile, PROFILE_PATH } from "./analyze/analyzer.js";
export { runGates, resolveGates, gatesPassed, parseCoverage } from "./gates/runner.js";
export { generateContext, renderContextMarkdown } from "./context/generator.js";
export { buildGateReport, writeReport, renderMarkdown, listReports } from "./report/reporter.js";
export { checkCommand } from "./guardrails/commandPolicy.js";
export { redactSecrets, findSecrets } from "./guardrails/secrets.js";
export { checkDiff, isGitRepo, matchesProtected } from "./guardrails/diffBudget.js";
export {
  createRequirement,
  lintRequirement,
  loadRequirement,
  listRequirements,
} from "./requirements/requirements.js";
export {
  startSession,
  endSession,
  appendEvent,
  getActiveSession,
  loadSession,
  loadEvents,
  listSessions,
  readPromptHistory,
  writeHandoff,
  SESSIONS_DIR,
  PROMPT_HISTORY_PATH,
} from "./session/store.js";
export { integrateClaude, integrateCodex, isClaudeHookInstalled } from "./integrations/install.js";
export { registerAdapter, getAdapters } from "./adapters/registry.js";
export type { StackAdapter, AdapterDetection } from "./adapters/types.js";
export { Logger } from "./core/logger.js";
