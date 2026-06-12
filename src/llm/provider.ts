/**
 * LLM provider abstraction. The harness core never talks to a vendor API
 * directly — it asks a provider for a completion. Adding a provider =
 * one file + one registry entry (mirrors the stack-adapter pattern).
 */
import type { HarnessConfig } from "../config/schema.js";
import { anthropicProvider } from "./anthropic.js";
import { claudeCliAvailable, claudeCliProvider } from "./claudeCli.js";

export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmProvider {
  id: string;
  complete(req: CompletionRequest, config: HarnessConfig["llm"]): Promise<string>;
}

const providers = new Map<string, LlmProvider>([
  [anthropicProvider.id, anthropicProvider],
  [claudeCliProvider.id, claudeCliProvider],
]);

export function registerProvider(provider: LlmProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`LLM provider "${provider.id}" is already registered`);
  }
  providers.set(provider.id, provider);
}

export function getProvider(id: string): LlmProvider {
  const provider = providers.get(id);
  if (!provider) {
    throw new Error(`unknown LLM provider "${id}" — available: ${[...providers.keys()].join(", ")}`);
  }
  return provider;
}

/**
 * Resolve the provider for a config, handling "auto":
 *   1. configured API key env var is set            -> anthropic
 *   2. ANTHROPIC_AUTH_TOKEN set (ant auth login)    -> anthropic (SDK resolves it)
 *   3. local Claude Code CLI available              -> claude-cli (uses the
 *      developer's logged-in Claude Code session, no API key needed)
 */
export function resolveProvider(config: HarnessConfig["llm"]): LlmProvider {
  if (config.provider !== "auto") return getProvider(config.provider);
  if (process.env[config.apiKeyEnv] || process.env.ANTHROPIC_AUTH_TOKEN) {
    return anthropicProvider;
  }
  if (claudeCliAvailable(config)) return claudeCliProvider;
  throw new Error(
    `no LLM credentials found — set ${config.apiKeyEnv}, run \`ant auth login\`, ` +
      "install/log in to Claude Code (claude CLI), or pin llm.provider in harness.yaml",
  );
}
