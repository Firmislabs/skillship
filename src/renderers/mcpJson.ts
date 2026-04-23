import type { Database as Sqlite3Database } from "better-sqlite3";
import { readBestClaim } from "./claims.js";

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
    const baseUrl = readBestClaim(input.db, s.id, "base_url");
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

function serialise(obj: McpJsonShape): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}
