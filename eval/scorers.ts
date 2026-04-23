import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import type { Database as Sqlite3Database } from "better-sqlite3";

export interface ExpectedOp {
  readonly method: string;
  readonly path: string;
}

export interface CoverageReport {
  readonly expected: number;
  readonly hits: ExpectedOp[];
  readonly misses: ExpectedOp[];
  readonly hitRate: number;
}

export interface GroundingReport {
  readonly sampled: number;
  readonly resolved: number;
  readonly unresolved: Array<{ claimId: string; reason: string }>;
  readonly hitRate: number;
}

export interface FormatReport {
  readonly ok: boolean;
  readonly message: string;
}

const VALIDATOR = "vendor/anthropic-skills/quick_validate.py";

export function scoreCoverage(
  db: Sqlite3Database,
  productId: string,
  expected: readonly ExpectedOp[],
): CoverageReport {
  if (expected.length === 0) {
    return { expected: 0, hits: [], misses: [], hitRate: 1 };
  }
  const graphOps = readGraphOps(db, productId);
  const seen = new Set(graphOps.map(fingerprint));
  const hits: ExpectedOp[] = [];
  const misses: ExpectedOp[] = [];
  for (const e of expected) {
    if (seen.has(fingerprint(e))) hits.push(e);
    else misses.push(e);
  }
  return {
    expected: expected.length,
    hits,
    misses,
    hitRate: hits.length / expected.length,
  };
}

export function scoreGrounding(
  db: Sqlite3Database,
  sourcesDir: string,
  sampleSize: number,
): GroundingReport {
  const rows = db
    .prepare(
      `SELECT c.id AS claim_id, c.source_id, s.id AS src_exists
         FROM claims c
         LEFT JOIN sources s ON s.id = c.source_id
         ORDER BY c.id
         LIMIT ?`,
    )
    .all(sampleSize) as ClaimRow[];
  const unresolved: Array<{ claimId: string; reason: string }> = [];
  let resolved = 0;
  for (const r of rows) {
    const reason = checkGrounding(r, sourcesDir);
    if (reason === null) resolved += 1;
    else unresolved.push({ claimId: r.claim_id, reason });
  }
  const sampled = rows.length;
  return {
    sampled,
    resolved,
    unresolved,
    hitRate: sampled === 0 ? 1 : resolved / sampled,
  };
}

export function scoreFormat(skillDir: string): FormatReport {
  try {
    const stdout = execFileSync("python3", [VALIDATOR, skillDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, message: stdout.trim() };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; message?: string };
    const msg =
      typeof e.stdout === "string"
        ? e.stdout.trim()
        : Buffer.isBuffer(e.stdout)
          ? e.stdout.toString("utf8").trim()
          : (e.message ?? "unknown validator failure");
    return { ok: false, message: msg };
  }
}

interface GraphOpRow {
  readonly method: string;
  readonly path: string;
}

interface ClaimRow {
  readonly claim_id: string;
  readonly source_id: string;
  readonly src_exists: string | null;
}

function readGraphOps(
  db: Sqlite3Database,
  productId: string,
): GraphOpRow[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT m.value_json AS method, p.value_json AS path
         FROM nodes n
         JOIN nodes s  ON s.id = n.parent_id
         JOIN claims m ON m.node_id = n.id AND m.field='method'
         JOIN claims p ON p.node_id = n.id AND p.field='path_or_name'
        WHERE n.kind='operation' AND s.parent_id = ?`,
    )
    .all(productId) as { method: string; path: string }[];
  return rows.map((r) => ({
    method: JSON.parse(r.method) as string,
    path: JSON.parse(r.path) as string,
  }));
}

function fingerprint(op: ExpectedOp | GraphOpRow): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

function checkGrounding(row: ClaimRow, sourcesDir: string): string | null {
  if (row.src_exists === null) return "missing source row";
  if (!existsSync(sourcesDir)) return "sources dir missing";
  const files = readdirSync(sourcesDir);
  const found = files.some((f) => f.startsWith(`${row.source_id}.`));
  return found ? null : "source bytes not on disk";
}
