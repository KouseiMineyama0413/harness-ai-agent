/**
 * Public programmatic API. The CLI is a thin layer over these exports, so
 * other tools (CI plugins, MCP servers, editor extensions) can embed the
 * harness without shelling out.
 */
export * from "./types.js";
export { harnessConfigSchema, defaultConfig, type HarnessConfig } from "./config/schema.js";
export { loadConfig, ConfigError, CONFIG_FILENAME } from "./config/load.js";
export { analyzeProject, loadProfile, PROFILE_PATH } from "./analyze/analyzer.js";
export { runGates, resolveGates, gatesPassed, parseCoverage, substituteChanged } from "./gates/runner.js";
export { generateContext, renderContextMarkdown } from "./context/generator.js";
export { tuningRules } from "./context/tuning.js";
export { buildBrief, type BriefOptions } from "./context/brief.js";
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
export { HarnessDb, DB_PATH } from "./db/database.js";
export {
  addClaim,
  releaseClaim,
  releaseAgentClaims,
  listClaims,
  findClaimConflicts,
  CLAIMS_PATH,
} from "./guardrails/claims.js";
export { createPlan, setPlanStatus, listPlans, loadPlan, hasApprovedPlan, PLANS_DIR } from "./plans/plans.js";
export { buildPrSummary } from "./report/prSummary.js";
export { runDoctor, type DoctorCheck } from "./doctor/doctor.js";
export { summarizeSession } from "./session/summarize.js";
export { getProvider, resolveProvider, registerProvider, type LlmProvider } from "./llm/provider.js";
export { claudeCliProvider, claudeCliAvailable } from "./llm/claudeCli.js";
export { startMcpServer } from "./mcp/server.js";
export { integrateGitHooks } from "./integrations/install.js";
export { upsertMarkedBlock, beginMarker, endMarker, generatedFileHeader, isGeneratedFile } from "./core/markers.js";
export { syncSkillAndCommands, renderSkill, SKILL_PATH, COMMANDS_DIR } from "./integrations/skill.js";
export { generateDocs, checkDocs, DOC_TYPES, type DocType } from "./docs/generate.js";
export { collectDocSources, renderSources, type DocSource } from "./docs/sources.js";
export { registerAdapter, getAdapters } from "./adapters/registry.js";
export type { StackAdapter, AdapterDetection } from "./adapters/types.js";
export { Logger } from "./core/logger.js";
