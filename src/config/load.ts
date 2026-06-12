import path from "node:path";
import YAML from "yaml";
import { ZodError } from "zod";
import { readIfExists } from "../core/fsutil.js";
import { defaultConfig, harnessConfigSchema, type HarnessConfig } from "./schema.js";

export const CONFIG_FILENAME = "harness.yaml";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  config: HarnessConfig;
  /** Absolute path of the file the config was loaded from, or null when defaulted. */
  source: string | null;
}

/**
 * Load harness.yaml from the project root. When absent, fall back to a
 * default config named after the directory so read-only commands still work.
 */
export function loadConfig(root: string): LoadedConfig {
  const configPath = path.join(root, CONFIG_FILENAME);
  const raw = readIfExists(configPath);
  if (raw === null) {
    return { config: defaultConfig(path.basename(root)), source: null };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new ConfigError(`${CONFIG_FILENAME}: YAML parse error: ${(err as Error).message}`);
  }

  try {
    return { config: harnessConfigSchema.parse(parsed), source: configPath };
  } catch (err) {
    if (err instanceof ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("\n");
      throw new ConfigError(`${CONFIG_FILENAME}: invalid configuration:\n${issues}`);
    }
    throw err;
  }
}
