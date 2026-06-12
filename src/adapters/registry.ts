import { nodeAdapter } from "./node.js";
import { pythonAdapter } from "./python.js";
import { goAdapter } from "./go.js";
import { infraAdapter } from "./infra.js";
import type { StackAdapter } from "./types.js";

/**
 * Adapter registry. Order matters: earlier adapters win when two adapters
 * infer a command for the same gate (e.g. a repo with both package.json
 * and pyproject.toml uses the Node commands unless config overrides).
 *
 * Extension point: external plugins can call registerAdapter() before the
 * analyzer runs (future: load from harness.yaml `plugins:` entries).
 */
const adapters: StackAdapter[] = [nodeAdapter, pythonAdapter, goAdapter, infraAdapter];

export function getAdapters(): readonly StackAdapter[] {
  return adapters;
}

export function registerAdapter(adapter: StackAdapter): void {
  if (adapters.some((a) => a.id === adapter.id)) {
    throw new Error(`Adapter with id "${adapter.id}" is already registered`);
  }
  adapters.push(adapter);
}
