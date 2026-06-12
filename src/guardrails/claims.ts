/**
 * Work claims: exclusive path reservations that stop concurrent agents
 * (claude and codex working in parallel) from editing the same files.
 *
 * Claims live in .harness/claims.json (committed, human-reviewable).
 * `guard scan-diff` treats changes to a path claimed by a DIFFERENT agent
 * as a violation; claiming itself fails fast on overlap.
 */
import path from "node:path";
import { readJsonIfExists, writeJson } from "../core/fsutil.js";
import { getActiveSession } from "../session/store.js";
import type { Claim } from "../types.js";

export const CLAIMS_PATH = ".harness/claims.json";

interface ClaimsFile {
  schemaVersion: 1;
  claims: Claim[];
}

function claimsFile(root: string): string {
  return path.join(root, CLAIMS_PATH);
}

export function listClaims(root: string): Claim[] {
  return readJsonIfExists<ClaimsFile>(claimsFile(root))?.claims ?? [];
}

function save(root: string, claims: Claim[]): void {
  writeJson(claimsFile(root), { schemaVersion: 1, claims } satisfies ClaimsFile);
}

/** Normalize a repo-relative path: forward slashes, no ./ prefix, no trailing /. */
export function normalizeClaimPath(p: string): string {
  return p.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when `claimPath` covers `file` (equal, or file lives under the dir). */
export function claimCovers(claimPath: string, file: string): boolean {
  return file === claimPath || file.startsWith(claimPath + "/");
}

/** Two claims overlap when either path covers the other. */
function overlaps(a: string, b: string): boolean {
  return claimCovers(a, b) || claimCovers(b, a);
}

export function addClaim(root: string, rawPath: string, agent: string, reason?: string): Claim {
  const claimPath = normalizeClaimPath(rawPath);
  if (!claimPath) throw new Error("claim path must not be empty");
  const claims = listClaims(root);

  const conflict = claims.find((c) => c.agent !== agent && overlaps(c.path, claimPath));
  if (conflict) {
    throw new Error(
      `path "${claimPath}" conflicts with claim on "${conflict.path}" held by ${conflict.agent}` +
        ` (since ${conflict.claimedAt}) — coordinate or wait for release`,
    );
  }

  // Re-claiming your own path (or a sub-path of it) is a no-op refresh.
  const own = claims.find((c) => c.agent === agent && c.path === claimPath);
  if (own) return own;

  const claim: Claim = {
    path: claimPath,
    agent,
    sessionId: getActiveSession(root)?.id ?? null,
    claimedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  };
  save(root, [...claims, claim]);
  return claim;
}

export function releaseClaim(root: string, rawPath: string, agent: string): void {
  const claimPath = normalizeClaimPath(rawPath);
  const claims = listClaims(root);
  const target = claims.find((c) => c.path === claimPath);
  if (!target) throw new Error(`no claim on "${claimPath}"`);
  if (target.agent !== agent) {
    throw new Error(`claim on "${claimPath}" is held by ${target.agent}, not ${agent}`);
  }
  save(
    root,
    claims.filter((c) => c !== target),
  );
}

/** Release every claim held by an agent (typical at session end / handoff). */
export function releaseAgentClaims(root: string, agent: string): number {
  const claims = listClaims(root);
  const remaining = claims.filter((c) => c.agent !== agent);
  if (remaining.length !== claims.length) save(root, remaining);
  return claims.length - remaining.length;
}

/** Changed files that fall under a claim held by a different agent. */
export function findClaimConflicts(
  files: string[],
  agent: string,
  claims: Claim[],
): { file: string; claimedBy: string; path: string }[] {
  const conflicts: { file: string; claimedBy: string; path: string }[] = [];
  for (const file of files) {
    const normalized = normalizeClaimPath(file);
    for (const claim of claims) {
      if (claim.agent !== agent && claimCovers(claim.path, normalized)) {
        conflicts.push({ file, claimedBy: claim.agent, path: claim.path });
        break;
      }
    }
  }
  return conflicts;
}
