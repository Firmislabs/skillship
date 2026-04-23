import type { Database as Sqlite3Database } from "better-sqlite3";
import { DEFAULT_PRECEDENCE } from "../graph/merge.js";

export function readBestClaim(
  db: Sqlite3Database,
  nodeId: string,
  field: string,
): string | undefined {
  const rows = db
    .prepare(
      `SELECT value_json, extractor FROM claims
       WHERE node_id=? AND field=? ORDER BY id`,
    )
    .all(nodeId, field) as { value_json: string; extractor: string }[];
  if (rows.length === 0) return undefined;
  const sorted = [...rows].sort(
    (a, b) =>
      (DEFAULT_PRECEDENCE.extractor[b.extractor] ?? 0) -
      (DEFAULT_PRECEDENCE.extractor[a.extractor] ?? 0),
  );
  const first = sorted[0]!;
  const v = JSON.parse(first.value_json);
  return typeof v === "string" ? v : undefined;
}
