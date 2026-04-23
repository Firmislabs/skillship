import type { Database as Sqlite3Database } from "better-sqlite3";
import type {
  ClaimConfidence,
  EdgeKind,
  NodeKind,
  SurfaceKind,
} from "./types.js";

export interface NodeRow {
  id: string;
  kind: NodeKind;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClaimRow {
  id: string;
  node_id: string;
  field: string;
  value_json: string;
  source_id: string;
  extractor: string;
  extracted_at: string;
  span_start: number | null;
  span_end: number | null;
  span_path: string | null;
  confidence: ClaimConfidence;
  chosen: 0 | 1;
  rejection_rationale: string | null;
}

export interface EdgeRow {
  id: string;
  kind: EdgeKind;
  from_node_id: string;
  to_node_id: string;
  source_id: string | null;
  rationale: string | null;
  created_at: string;
}

export interface OverrideRow {
  id: string;
  node_id: string;
  field: string;
  value_json: string;
  rationale: string;
  authored_by: string;
  authored_at: string;
  supersedes: string | null;
  active: 0 | 1;
}

export interface SourceRow {
  id: string;
  surface: SurfaceKind;
  url: string;
  content_type: string;
  fetched_at: string;
  bytes: number;
  cache_path: string;
}

export function insertNode(db: Sqlite3Database, row: NodeRow): void {
  db.prepare(
    `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
     VALUES (@id, @kind, @parent_id, @created_at, @updated_at)`,
  ).run(row);
}

export function getNode(db: Sqlite3Database, id: string): NodeRow | null {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
    | NodeRow
    | undefined;
  return row ?? null;
}

export function listNodesByKind(
  db: Sqlite3Database,
  kind: NodeKind,
): NodeRow[] {
  return db
    .prepare("SELECT * FROM nodes WHERE kind = ? ORDER BY id")
    .all(kind) as NodeRow[];
}

export function insertClaim(db: Sqlite3Database, row: ClaimRow): void {
  db.prepare(
    `INSERT INTO claims
       (id, node_id, field, value_json, source_id, extractor, extracted_at,
        span_start, span_end, span_path, confidence, chosen, rejection_rationale)
     VALUES
       (@id, @node_id, @field, @value_json, @source_id, @extractor, @extracted_at,
        @span_start, @span_end, @span_path, @confidence, @chosen, @rejection_rationale)`,
  ).run(row);
}

export function listClaimsForField(
  db: Sqlite3Database,
  nodeId: string,
  field: string,
): ClaimRow[] {
  return db
    .prepare(
      "SELECT * FROM claims WHERE node_id = ? AND field = ? ORDER BY extracted_at, id",
    )
    .all(nodeId, field) as ClaimRow[];
}

export function listAllClaimsForNode(
  db: Sqlite3Database,
  nodeId: string,
): ClaimRow[] {
  return db
    .prepare(
      "SELECT * FROM claims WHERE node_id = ? ORDER BY field, extracted_at, id",
    )
    .all(nodeId) as ClaimRow[];
}

export function setClaimChosen(
  db: Sqlite3Database,
  claimId: string,
  chosen: 0 | 1,
  rejectionRationale: string | null = null,
): void {
  db.prepare(
    `UPDATE claims SET chosen = @chosen, rejection_rationale = @rr WHERE id = @id`,
  ).run({ chosen, rr: rejectionRationale, id: claimId });
}

export function insertEdge(db: Sqlite3Database, row: EdgeRow): void {
  db.prepare(
    `INSERT OR IGNORE INTO edges
       (id, kind, from_node_id, to_node_id, source_id, rationale, created_at)
     VALUES
       (@id, @kind, @from_node_id, @to_node_id, @source_id, @rationale, @created_at)`,
  ).run(row);
}

export function listEdgesFrom(
  db: Sqlite3Database,
  fromNodeId: string,
  kind?: EdgeKind,
): EdgeRow[] {
  if (kind !== undefined) {
    return db
      .prepare(
        "SELECT * FROM edges WHERE from_node_id = ? AND kind = ? ORDER BY id",
      )
      .all(fromNodeId, kind) as EdgeRow[];
  }
  return db
    .prepare("SELECT * FROM edges WHERE from_node_id = ? ORDER BY id")
    .all(fromNodeId) as EdgeRow[];
}

export function listEdgesTo(
  db: Sqlite3Database,
  toNodeId: string,
  kind?: EdgeKind,
): EdgeRow[] {
  if (kind !== undefined) {
    return db
      .prepare(
        "SELECT * FROM edges WHERE to_node_id = ? AND kind = ? ORDER BY id",
      )
      .all(toNodeId, kind) as EdgeRow[];
  }
  return db
    .prepare("SELECT * FROM edges WHERE to_node_id = ? ORDER BY id")
    .all(toNodeId) as EdgeRow[];
}

export function insertOverride(db: Sqlite3Database, row: OverrideRow): void {
  db.prepare(
    `INSERT INTO overrides
       (id, node_id, field, value_json, rationale, authored_by, authored_at,
        supersedes, active)
     VALUES
       (@id, @node_id, @field, @value_json, @rationale, @authored_by, @authored_at,
        @supersedes, @active)`,
  ).run(row);
}

export function listActiveOverrides(
  db: Sqlite3Database,
  nodeId: string,
  field: string,
): OverrideRow[] {
  return db
    .prepare(
      `SELECT * FROM overrides
       WHERE node_id = ? AND field = ? AND active = 1
       ORDER BY authored_at DESC, id`,
    )
    .all(nodeId, field) as OverrideRow[];
}

export function deactivateOverride(db: Sqlite3Database, id: string): void {
  db.prepare("UPDATE overrides SET active = 0 WHERE id = ?").run(id);
}

export function upsertSource(db: Sqlite3Database, row: SourceRow): SourceRow {
  db.prepare(
    `INSERT OR IGNORE INTO sources
       (id, surface, url, content_type, fetched_at, bytes, cache_path)
     VALUES
       (@id, @surface, @url, @content_type, @fetched_at, @bytes, @cache_path)`,
  ).run(row);
  const existing = getSource(db, row.id);
  if (existing === null) {
    throw new Error(`upsertSource: row ${row.id} missing after insert`);
  }
  return existing;
}

export function getSource(
  db: Sqlite3Database,
  id: string,
): SourceRow | null {
  const row = db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
    | SourceRow
    | undefined;
  return row ?? null;
}
