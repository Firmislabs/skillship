// src/renderers/sdk-fs.ts
// Filesystem helpers extracted from sdk.ts to keep that file under 300 lines.
// All five functions are pure FS utilities with no dependency on OAS/SDK logic.
import {
  cpSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

// ---- Atomic rename (cross-filesystem-safe) ----

export function atomicMove(tempDir: string, outDir: string): void {
  mkdirSync(dirname(outDir), { recursive: true });
  if (statSyncSafe(outDir)) rmSync(outDir, { recursive: true, force: true });
  crossFsRename(tempDir, outDir);
}

/**
 * Renames src → dst atomically where possible.
 * Falls back to cpSync + rmSync when renameSync throws EXDEV (cross-device
 * move — common in CI containers where /tmp is tmpfs and outDir is on the
 * host filesystem). If cpSync itself fails, dst is removed before re-throwing
 * to preserve the "dst absent on failure" invariant.
 */
export function crossFsRename(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== "EXDEV") throw err;
    try {
      cpSync(src, dst, { recursive: true });
    } catch (copyErr) {
      rmSync(dst, { recursive: true, force: true });
      throw copyErr;
    }
    rmSync(src, { recursive: true, force: true });
  }
}

export function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") return false;
    throw err;
  }
}

// ---- File listing ----

export function listEmittedFiles(outDir: string): readonly string[] {
  const out: string[] = [];
  for (const f of walkAll(outDir)) out.push(relative(outDir, f));
  return out.sort();
}

export function* walkAll(dir: string): IterableIterator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkAll(full);
    else yield full;
  }
}
