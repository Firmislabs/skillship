import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderMcpJson } from "../../src/renderers/mcpJson.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-04-23T12:00:00.000Z";

interface SeedSource {
  readonly surface: "rest" | "mcp";
  readonly url: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

async function seed(
  graph: GraphDb,
  productId: string,
  sources: SeedSource[],
): Promise<void> {
  const config: SkillshipConfig = {
    product: { domain: "x.example", github_org: null },
    sources: sources.map((s) => ({
      surface: s.surface,
      url: s.url,
      sha256: createHash("sha256").update(s.bytes).digest("hex"),
      content_type: s.contentType,
      fetched_at: NOW,
    })),
    coverage: "bronze",
  };
  const bytesByUrl = new Map(
    sources.map((s) => [
      createHash("sha256").update(s.bytes).digest("hex"),
      s.bytes,
    ]),
  );
  await ingestConfig({
    db: graph.db,
    config,
    productId,
    loadBytes: async (sha) => bytesByUrl.get(sha) ?? Buffer.from(""),
    now: () => NOW,
  });
}

const MCP_BYTES = readFileSync(
  join(process.cwd(), "tests/fixtures/mcp-well-known/sample.json"),
);
const OPENAPI_BYTES = readFileSync(
  join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"),
);

describe("renderMcpJson", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillship-mcpjson-"));
    graph = openGraph(join(tmp, "graph.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("product with no mcp surface → empty mcpServers object", () => {
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES ('p-empty', 'product', NULL, @now, @now)`,
      )
      .run({ now: NOW });
    const out = renderMcpJson({
      db: graph.db,
      productId: "p-empty",
      serverName: "empty",
    });
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ mcpServers: {} });
  });

  test("emits http server entry from mcp well-known surface", async () => {
    await seed(graph, "p-mcp", [
      {
        surface: "mcp",
        url: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        contentType: "application/json; charset=utf-8",
        bytes: MCP_BYTES,
      },
    ]);
    const out = renderMcpJson({
      db: graph.db,
      productId: "p-mcp",
      serverName: "supabase",
    });
    const parsed = JSON.parse(out);
    expect(parsed.mcpServers.supabase).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
  });

  test("ignores non-mcp surfaces", async () => {
    await seed(graph, "p-mixed", [
      {
        surface: "rest",
        url: "https://x.example/openapi.yaml",
        contentType: "application/openapi+yaml",
        bytes: OPENAPI_BYTES,
      },
      {
        surface: "mcp",
        url: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        contentType: "application/json",
        bytes: MCP_BYTES,
      },
    ]);
    const out = renderMcpJson({
      db: graph.db,
      productId: "p-mixed",
      serverName: "mixed",
    });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.mcpServers)).toEqual(["mixed"]);
    expect(parsed.mcpServers.mixed.type).toBe("http");
  });

  test("skips mcp surfaces that have no base_url claim", () => {
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES
           ('p-nb', 'product', NULL, @now, @now),
           ('srf-nb', 'surface', 'p-nb', @now, @now)`,
      )
      .run({ now: NOW });
    graph.db
      .prepare(
        `INSERT INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
         VALUES ('src-nb', 'mcp', 'http://x', 'application/json', @now, 0, '/tmp/x')`,
      )
      .run({ now: NOW });
    graph.db
      .prepare(
        `INSERT INTO claims
           (id, node_id, field, value_json, source_id, extractor, extracted_at,
            span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES
           ('c-t', 'srf-nb', 'type', '"mcp"', 'src-nb', 'mcp-well-known@1',
            @now, NULL, NULL, '$', 'derived', 0, NULL)`,
      )
      .run({ now: NOW });
    const out = renderMcpJson({
      db: graph.db,
      productId: "p-nb",
      serverName: "nb",
    });
    expect(JSON.parse(out)).toEqual({ mcpServers: {} });
  });

  test("output is pretty-printed with 2-space indent", async () => {
    await seed(graph, "p-fmt", [
      {
        surface: "mcp",
        url: "https://x/.well-known/oauth-protected-resource/mcp",
        contentType: "application/json",
        bytes: MCP_BYTES,
      },
    ]);
    const out = renderMcpJson({
      db: graph.db,
      productId: "p-fmt",
      serverName: "fmt",
    });
    expect(out).toMatch(/\n  "mcpServers":/);
    expect(out.endsWith("\n")).toBe(true);
  });

  test("serverName defaults to productId-derived slug when not provided", async () => {
    await seed(graph, "p-default", [
      {
        surface: "mcp",
        url: "https://x/.well-known/oauth-protected-resource/mcp",
        contentType: "application/json",
        bytes: MCP_BYTES,
      },
    ]);
    const out = renderMcpJson({
      db: graph.db,
      productId: "p-default",
    });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.mcpServers)).toEqual(["p-default"]);
  });
});
