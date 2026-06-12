import type { DetectedTechnology, GateId } from "../types.js";

/** What an adapter reports back after inspecting a repository. */
export interface AdapterDetection {
  technologies: DetectedTechnology[];
  /** Gate commands this adapter can infer (config overrides win). */
  commands: Partial<Record<GateId, string>>;
  /**
   * Changed-files command templates for `gate run --changed`.
   * Placeholders: {files} = changed files, {dirs} = their unique directories.
   */
  changedCommands?: Partial<Record<GateId, string>>;
  /** Files worth surfacing to humans/agents (entry points, configs). */
  notableFiles: string[];
}

/**
 * A stack adapter encapsulates all knowledge about one ecosystem.
 * Adding support for a new language/framework = adding one adapter,
 * no core changes required.
 */
export interface StackAdapter {
  id: string;
  /** Cheap check: should this adapter run a full detect on the repo? */
  applies(root: string): boolean;
  /** Full detection. Only called when applies() returned true. */
  detect(root: string): AdapterDetection;
}
