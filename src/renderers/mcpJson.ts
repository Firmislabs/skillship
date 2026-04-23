import type { Database as Sqlite3Database } from "better-sqlite3";
import { DEFAULT_PRECEDENCE } from "../graph/merge.js";

export interface RenderMcpJsonInput {
  readonly db: Sqlite3Database;
  readonly productId: string;
  readonly serverName?: string;
}

interface McpServerEntry {
  readonly type: "http";
  readonly url: string;
}

interface McpJsonShape {
  readonly mcpServers: Record<string, McpServerEntry>;
}

export function renderMcpJson(input: RenderMcpJsonInput): string {
  const mcpSurfaces = listMcpSurfaces(input.db, input.productId);
  const mcpServers: Record<string, McpServerEntry> = {};
  const name = input.serverName ?? input.productId;
  if (mcpSurfaces.length === 0) {
    return serialise({ mcpServers });
  }
  mcpSurfaces.forEach((s, idx) => {
    const baseUrl = readClaim(input.db, s.id, "base_url");
    if (baseUrl === undefined) return;
    const key = mcpSurfaces.length === 1 ? name : `${name}-${idx + 1}`;
    mcpServers[key] = { type: "http", url: baseUrl };
  });
  return serialise({ mcpServers });
}

function listMcpSurfaces(
  db: Sqlite3Database,
  productId: string,
): { id: string }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT n.id AS id
         FROM nodes n
         JOIN claims c   ON c.node_id = n.id
         JOIN sources s  ON s.id = c.source_id
        WHERE n.kind='surface' AND n.parent_id=? AND s.surface='mcp'
        ORDER BY n.id`,
    )
    .all(productId) as { id: string }[];
  return rows;
}

function readClaim(
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

function serialise(obj: McpJsonShape): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}
