/**
 * CCR object store — content-addressed storage for reversible compression.
 *
 * When the harness compresses a large blob before sending it to an LLM, the
 * original must remain retrievable on demand (Compress-Cache-Retrieve). We
 * store originals as content-addressed files under `.harness/ccr/`, mirroring
 * the project's "files are the source of truth" principle (and git's object
 * model): durable, dedup-by-hash, and trivially prunable by mtime. This is the
 * source of truth — unlike the SQLite index, it cannot be regenerated, so it
 * lives next to (not inside) the disposable cache and is git-ignored as a
 * machine-local retrieval cache.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readIfExists } from "../core/fsutil.js";

export const CCR_DIR = ".harness/ccr";
/** Handle length: 16 hex chars (64 bits) — collision-safe for this scale. */
const HANDLE_LEN = 16;

export interface CcrObject {
  hash: string;
  bytes: number;
  createdAt: string;
}

/** Content handle for a blob (stable: same content → same handle). */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex").slice(0, HANDLE_LEN);
}

function objectPath(root: string, hash: string): string {
  return path.join(root, CCR_DIR, `${hash}.txt`);
}

/** Validate a handle so retrieval can never escape the store directory. */
export function isValidHandle(hash: string): boolean {
  return new RegExp(`^[0-9a-f]{${HANDLE_LEN}}$`).test(hash);
}

/** Store an original blob; returns its handle. Idempotent by content. */
export function putOriginal(root: string, content: string): { hash: string; bytes: number } {
  const hash = hashContent(content);
  const file = objectPath(root, hash);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
  }
  return { hash, bytes: Buffer.byteLength(content, "utf8") };
}

/** Retrieve an original by handle, or null if unknown/expired. */
export function getOriginal(root: string, hash: string): string | null {
  if (!isValidHandle(hash)) return null;
  return readIfExists(objectPath(root, hash));
}

/** List stored objects with size and creation time. */
export function listObjects(root: string): CcrObject[] {
  const dir = path.join(root, CCR_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { hash: f.replace(/\.txt$/, ""), bytes: stat.size, createdAt: stat.mtime.toISOString() };
    });
}

/** Remove objects older than `ttlDays`. Returns the number removed. */
export function pruneExpired(root: string, ttlDays: number, now = Date.now()): number {
  const dir = path.join(root, CCR_DIR);
  if (!fs.existsSync(dir)) return 0;
  const cutoff = now - ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".txt")) continue;
    const file = path.join(dir, f);
    if (fs.statSync(file).mtimeMs < cutoff) {
      fs.rmSync(file);
      removed++;
    }
  }
  return removed;
}
