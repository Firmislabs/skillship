import type { Database as Sqlite3Database } from "better-sqlite3";
import { readBestClaim } from "./claims.js";

/**
 * A stdio MCP server entry pointing at the locally-emitted SDK MCP launcher.
 * Threaded in by the build orchestrator when the SDK ships its MCP server; the
 * path is RELATIVE to the .mcp.json location (e.g. "sdk/bin/mcp.js").
 */
export interface LocalSdkServer {
  readonly command: string;
  readonly args: readonly string[];
}

export interface RenderMcpJsonInput {
  readonly db: Sqlite3Database;
  readonly productId: string;
  readonly serverName?: string;
  /**
   * When provided, adds a stdio entry keyed by productId alongside any vendor
   * (remote http) entries. Omit it (the --skip-sdk/--skip-mcp path) to preserve
   * the prior vendor-only behavior byte-for-byte.
   */
  readonly localSdkServer?: LocalSdkServer;
}

interface McpHttpEntry {
  readonly type: "http";
  readonly url: string;
}

type McpServerEntry = McpHttpEntry | LocalSdkServer;

interface McpJsonShape {
  readonly mcpServers: Record<string, McpServerEntry>;
}

export function renderMcpJson(input: RenderMcpJsonInput): string {
  const mcpServers: Record<string, McpServerEntry> = {};
  const name = input.serverName ?? input.productId;
  const mcpSurfaces = listMcpSurfaces(input.db, input.productId);
  mcpSurfaces.forEach((s, idx) => {
    const baseUrl = readBestClaim(input.db, s.id, "base_url");
    if (baseUrl === undefined) return;
    const key = mcpSurfaces.length === 1 ? name : `${name}-${idx + 1}`;
    mcpServers[key] = { type: "http", url: baseUrl };
  });
  if (input.localSdkServer !== undefined) {
    mcpServers[input.productId] = {
      command: input.localSdkServer.command,
      args: [...input.localSdkServer.args],
    };
  }
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
