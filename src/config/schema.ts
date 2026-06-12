import { z } from "zod";
import { ALL_GATE_IDS, type GateId } from "../types.js";

/** Per-gate configuration. `command: null` explicitly disables a gate. */
const gateConfigSchema = z
  .object({
    command: z.string().min(1).nullable().optional(),
    /**
     * Command template used by `gate run --changed`. Placeholders:
     * {files} = changed files, {dirs} = unique directories of changed files.
     */
    changedCommand: z.string().min(1).optional(),
    required: z.boolean().default(true),
    timeoutSec: z.number().int().positive().max(3600).default(600),
  })
  .strict();

const coverageGateSchema = gateConfigSchema
  .extend({
    /** Minimum line coverage percentage, checked against parsed output when available. */
    threshold: z.number().min(0).max(100).optional(),
  })
  .strict();

export const harnessConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .object({
        name: z.string().min(1),
        description: z.string().optional(),
      })
      .strict(),
    /** Manual stack hints; merged with auto-detection. */
    stacks: z.array(z.string()).default([]),
    agent: z
      .object({
        requirePlan: z.boolean().default(true),
        /**
         * Hard enforcement of requirePlan: `guard scan-diff` fails unless an
         * approved plan exists in .harness/plans/. Off by default so adopting
         * the harness never blocks an existing workflow.
         */
        enforcePlan: z.boolean().default(false),
        changeBudget: z
          .object({
            maxFiles: z.number().int().positive().default(20),
            maxLinesAdded: z.number().int().positive().default(800),
            maxLinesDeleted: z.number().int().positive().default(400),
          })
          .strict()
          .default({}),
        /** Glob-ish path prefixes an agent must not modify without human sign-off. */
        protectedPaths: z.array(z.string()).default([]),
        /** Extra regex patterns (as strings) added to the deny list. */
        deniedCommands: z.array(z.string()).default([]),
        /** Extra regex patterns that downgrade deny->confirm is NOT possible; allowlist exact safe commands. */
        allowedCommands: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    gates: z
      .object({
        lint: gateConfigSchema.optional(),
        typecheck: gateConfigSchema.optional(),
        test: gateConfigSchema.optional(),
        build: gateConfigSchema.optional(),
        security: gateConfigSchema.optional(),
        deps: gateConfigSchema.optional(),
        coverage: coverageGateSchema.optional(),
        /** Breaking-change detection (config-only; e.g. oasdiff, api-extractor). */
        breaking: gateConfigSchema.optional(),
      })
      .strict()
      .default({}),
    llm: z
      .object({
        /**
         * auto = API key if set, otherwise the local Claude Code session
         * (claude -p). Pin to "anthropic" or "claude-cli" to force one.
         */
        provider: z.enum(["auto", "anthropic", "claude-cli"]).default("auto"),
        /** Path to the claude binary (default "claude"; env HARNESS_CLAUDE_BIN wins). */
        claudeBin: z.string().optional(),
        model: z.string().optional(),
        apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
        maxTokens: z.number().int().positive().max(64000).default(2048),
      })
      .strict()
      .default({}),
    session: z
      .object({
        /** Record prompts to .harness/prompt_history.jsonl. On by default. */
        promptHistory: z.boolean().default(true),
        /** How many recent session events to embed in agent context. */
        contextEvents: z.number().int().positive().max(200).default(20),
      })
      .strict()
      .default({}),
    context: z
      .object({
        /** Extra files always included in agent context (paths relative to root). */
        includeFiles: z.array(z.string()).default([]),
        /** Extra free-form rules surfaced to the agent. */
        rules: z.array(z.string()).default([]),
      })
      .strict()
      .default({}),
    report: z
      .object({
        dir: z.string().default(".harness/reports"),
        formats: z.array(z.enum(["md", "json"])).default(["md", "json"]),
      })
      .strict()
      .default({}),
  })
  .strict();

export type HarnessConfig = z.infer<typeof harnessConfigSchema>;
export type GateConfig = z.infer<typeof gateConfigSchema>;

export function gateConfigFor(config: HarnessConfig, id: GateId): GateConfig | undefined {
  return config.gates[id];
}

/** Default config used by `harness init` and when harness.yaml is absent. */
export function defaultConfig(projectName: string): HarnessConfig {
  return harnessConfigSchema.parse({
    version: 1,
    project: { name: projectName },
  });
}

export { ALL_GATE_IDS };
