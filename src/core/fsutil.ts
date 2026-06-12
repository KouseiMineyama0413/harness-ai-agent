import fs from "node:fs";
import path from "node:path";

/** Read a UTF-8 file, returning null when it does not exist. */
export function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function readJsonIfExists<T>(filePath: string): T | null {
  const raw = readIfExists(filePath);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Invalid JSON in ${filePath}`);
  }
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}

/** List immediate subdirectories (names only), skipping dot/vendor dirs. */
export function listTopLevelDirs(root: string): string[] {
  const SKIP = new Set(["node_modules", "dist", "build", ".git", ".harness", "__pycache__", ".venv", "venv", "vendor", "target", ".next"]);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}
