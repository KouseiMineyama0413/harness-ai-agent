/**
 * Anthropic provider, via the official SDK.
 * The SDK is imported lazily so harness commands that never touch an LLM
 * don't pay its startup cost.
 */
import type { HarnessConfig } from "../config/schema.js";
import type { CompletionRequest, LlmProvider } from "./provider.js";

const DEFAULT_MODEL = "claude-opus-4-8";

export const anthropicProvider: LlmProvider = {
  id: "anthropic",

  async complete(req: CompletionRequest, config: HarnessConfig["llm"]): Promise<string> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    // When the configured env var is unset, fall back to the SDK's default
    // credential resolution (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
    // `ant auth login` profile) instead of failing immediately.
    const apiKey = process.env[config.apiKeyEnv];
    const client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();

    const response = await client.messages.create({
      model: config.model ?? DEFAULT_MODEL,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: "user", content: req.prompt }],
    });

    if (response.stop_reason === "refusal") {
      throw new Error("the model declined this request (stop_reason: refusal)");
    }
    const text = response.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (!text.trim()) throw new Error("model returned no text content");
    return text;
  },
};
