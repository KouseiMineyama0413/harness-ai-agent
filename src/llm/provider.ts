/**
 * LLM provider abstraction. The harness core never talks to a vendor API
 * directly — it asks a provider for a completion. Adding a provider =
 * one file + one registry entry (mirrors the stack-adapter pattern).
 */
import type { HarnessConfig } from "../config/schema.js";
import { anthropicProvider } from "./anthropic.js";

export interface CompletionRequest {
  system?: string;
  prompt: string;
  maxTokens: number;
}

export interface LlmProvider {
  id: string;
  complete(req: CompletionRequest, config: HarnessConfig["llm"]): Promise<string>;
}

const providers = new Map<string, LlmProvider>([[anthropicProvider.id, anthropicProvider]]);

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
