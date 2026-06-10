// src/sdk-plugins/mcp-server.ts
// Emits the generated src/mcp-server.ts (the MCP gateway) for the SDK package.
//
// The emitted module wires the three runtime concerns together:
//   1. tool definitions (tools/list) — search/describe/invoke schemas;
//   2. callTool dispatch — search (token-weighted scorer over the live CATALOG),
//      describe (full entry render), invoke (confirm gate + lazy Client + arg
//      routing + truncation + SDK error → isError);
//   3. main() — runStdioServer(createGateway()); NOT called at module top level
//      (the launcher invokes it).
//
// The emitter's signature is intentionally minimal — five baked inputs:
//   productName  → serverName "<productName>-mcp"
//   envPrefix    → derives <PREFIX>_BASE_URL and <PREFIX>_MCP_ALLOW_DESTRUCTIVE
//   baseUrl      → the baked default (string | null)
//   pkgVersion   → serverVersion
//   authEnvVars  → env-var NAMES baked into describe's auth section (the wiring
//                  task supplies them from REQUIRED_ENV_VARS knowledge).
//
// Per-section line-array builders live in two siblings (auth/auth-emit
// precedent) so every emitter file stays under the 300-line house rule:
//   ./mcp-server-emit.ts     — header/imports, scorer, createGateway, main.
//   ./mcp-server-dispatch.ts — tool defs + search/describe/invoke handlers.
//   ./mcp-server-lit.ts      — the shared `lit` literal helper.

import {
  buildHeader,
  buildScorer,
  buildCreateGateway,
  buildMain,
} from "./mcp-server-emit.js";
import {
  buildToolDefs,
  buildSearch,
  buildDescribe,
  buildInvoke,
} from "./mcp-server-dispatch.js";

export interface McpServerEmitOpts {
  readonly productName: string;
  readonly envPrefix: string;
  readonly baseUrl: string | null;
  readonly pkgVersion: string;
  readonly authEnvVars: readonly string[];
}

/**
 * Emits the generated src/mcp-server.ts module string.
 * Deterministic: identical opts always produce identical output.
 */
export function generateMcpServerModule(opts: McpServerEmitOpts): string {
  return [
    buildHeader(),
    buildScorer(),
    buildToolDefs(),
    buildSearch(),
    buildDescribe(opts.envPrefix, opts.baseUrl, opts.authEnvVars),
    buildInvoke(opts.envPrefix, opts.baseUrl),
    buildCreateGateway(opts.productName, opts.pkgVersion),
    buildMain(),
    "",
  ].join("\n");
}
