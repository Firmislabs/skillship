import type { Database as Sqlite3Database } from "better-sqlite3";
import { DEFAULT_PRECEDENCE } from "../graph/merge.js";
import { stableId } from "../extractors/openapi3-util.js";

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

/**
 * Returns the `base_url` claim for the REST surface of the given product,
 * or null if no such claim exists (no servers entry in the OpenAPI spec, or
 * no REST surface ingested for this product at all).
 *
 * The surface node id is deterministic: stableId("sfc", [productId, "rest"]),
 * mirroring the id emitted in src/extractors/openapi3.ts line 70.
 */
export function readRestBaseUrl(
  db: Sqlite3Database,
  productId: string,
): string | null {
  const surfaceId = stableId("sfc", [productId, "rest"]);
  return readBestClaim(db, surfaceId, "base_url") ?? null;
}
