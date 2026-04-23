import { randomUUID } from "node:crypto";
import type { Database as Sqlite3Database } from "better-sqlite3";
import type { Extraction } from "../extractors/types.js";
import {
  getNode,
  insertClaim,
  insertEdge,
  insertNode,
} from "../graph/repo.js";

export interface PersistOptions {
  readonly now?: () => string;
}

export interface PersistSummary {
  readonly nodesInserted: number;
  readonly claimsInserted: number;
  readonly edgesInserted: number;
}

export function persistExtraction(
  db: Sqlite3Database,
  extraction: Extraction,
  opts: PersistOptions = {},
): PersistSummary {
  const now = opts.now ?? (() => new Date().toISOString());
  let nodesInserted = 0;
  let claimsInserted = 0;
  let edgesInserted = 0;

  const txn = db.transaction((): void => {
    for (const node of extraction.nodes) {
      if (getNode(db, node.id) !== null) continue;
      const ts = now();
      insertNode(db, {
        id: node.id,
        kind: node.kind,
        parent_id: node.parent_id,
        created_at: ts,
        updated_at: ts,
      });
      nodesInserted += 1;
    }
    for (const claim of extraction.claims) {
      insertClaim(db, {
        id: randomUUID(),
        node_id: claim.node_id,
        field: claim.field,
        value_json: JSON.stringify(claim.value),
        source_id: extraction.source_id,
        extractor: extraction.extractor,
        extracted_at: now(),
        span_start: claim.span_start ?? null,
        span_end: claim.span_end ?? null,
        span_path: claim.span_path ?? null,
        confidence: claim.confidence,
        chosen: 0,
        rejection_rationale: null,
      });
      claimsInserted += 1;
    }
    for (const edge of extraction.edges) {
      insertEdge(db, {
        id: randomUUID(),
        kind: edge.kind,
        from_node_id: edge.from_node_id,
        to_node_id: edge.to_node_id,
        source_id: extraction.source_id,
        rationale: edge.rationale ?? null,
        created_at: now(),
      });
      edgesInserted += 1;
    }
  });
  txn();

  return { nodesInserted, claimsInserted, edgesInserted };
}
