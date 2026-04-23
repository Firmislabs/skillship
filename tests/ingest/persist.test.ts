import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { upsertSource } from "../../src/graph/repo.js";
import { persistExtraction } from "../../src/ingest/persist.js";
import type { Extraction } from "../../src/extractors/types.js";
import type { SourceRow } from "../../src/graph/repo.js";

const NOW = "2026-04-23T12:00:00.000Z";

function fixedNow(): string {
  return NOW;
}

function sourceRow(id: string): SourceRow {
  return {
    id,
    surface: "rest",
    url: `https://x.example/${id}`,
    content_type: "application/openapi+yaml",
    fetched_at: NOW,
    bytes: 10,
    cache_path: `/tmp/${id}`,
  };
}

describe("persistExtraction", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillship-persist-"));
    graph = openGraph(join(tmp, "graph.db"));
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES ('p-x', 'product', NULL, @now, @now)`,
      )
      .run({ now: NOW });
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("inserts nodes, claims, edges into a clean graph", () => {
    upsertSource(graph.db, sourceRow("src-1"));
    const ext: Extraction = {
      extractor: "openapi@3",
      source_id: "src-1",
      nodes: [
        { id: "srf-1", kind: "surface", parent_id: "p-x" },
        { id: "op-1", kind: "operation", parent_id: "srf-1" },
      ],
      claims: [
        {
          node_id: "op-1",
          field: "method",
          value: "GET",
          span_path: "$.paths./x.get",
          confidence: "attested",
        },
      ],
      edges: [
        {
          kind: "exposes",
          from_node_id: "srf-1",
          to_node_id: "op-1",
        },
      ],
    };
    const summary = persistExtraction(graph.db, ext, { now: fixedNow });
    expect(summary.nodesInserted).toBe(2);
    expect(summary.claimsInserted).toBe(1);
    expect(summary.edgesInserted).toBe(1);

    const nodes = graph.db.prepare("SELECT id FROM nodes ORDER BY id").all() as {
      id: string;
    }[];
    expect(nodes.map((n) => n.id)).toEqual(["op-1", "p-x", "srf-1"]);

    const claim = graph.db
      .prepare("SELECT * FROM claims WHERE node_id='op-1'")
      .get() as {
      field: string;
      value_json: string;
      extractor: string;
      source_id: string;
      confidence: string;
      span_path: string | null;
    };
    expect(claim.field).toBe("method");
    expect(JSON.parse(claim.value_json)).toBe("GET");
    expect(claim.extractor).toBe("openapi@3");
    expect(claim.source_id).toBe("src-1");
    expect(claim.confidence).toBe("attested");
    expect(claim.span_path).toBe("$.paths./x.get");
  });

  test("is idempotent on node re-insert (dedupe same id)", () => {
    upsertSource(graph.db, sourceRow("src-a"));
    const ext: Extraction = {
      extractor: "openapi@3",
      source_id: "src-a",
      nodes: [{ id: "op-dup", kind: "operation", parent_id: "p-x" }],
      claims: [],
      edges: [],
    };
    persistExtraction(graph.db, ext, { now: fixedNow });
    const second = persistExtraction(graph.db, ext, { now: fixedNow });
    expect(second.nodesInserted).toBe(0);
    const rows = graph.db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE id='op-dup'")
      .get() as { c: number };
    expect(rows.c).toBe(1);
  });

  test("each claim row has generated id + source_id + extractor stamped", () => {
    upsertSource(graph.db, sourceRow("src-b"));
    const ext: Extraction = {
      extractor: "sitemap@1",
      source_id: "src-b",
      nodes: [{ id: "dp-1", kind: "doc_page", parent_id: "p-x" }],
      claims: [
        {
          node_id: "dp-1",
          field: "url",
          value: "https://x.example/a",
          span_path: "$.urlset.url[0].loc",
          confidence: "attested",
        },
        {
          node_id: "dp-1",
          field: "title",
          value: "A",
          span_path: "$.urlset.url[0].loc",
          confidence: "derived",
        },
      ],
      edges: [],
    };
    persistExtraction(graph.db, ext, { now: fixedNow });
    const rows = graph.db
      .prepare(
        "SELECT id, extractor, source_id FROM claims WHERE node_id='dp-1' ORDER BY field",
      )
      .all() as { id: string; extractor: string; source_id: string }[];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    for (const r of rows) {
      expect(r.extractor).toBe("sitemap@1");
      expect(r.source_id).toBe("src-b");
    }
  });

  test("edges are stamped with source_id + generated id", () => {
    upsertSource(graph.db, sourceRow("src-c"));
    const ext: Extraction = {
      extractor: "mcp-well-known@1",
      source_id: "src-c",
      nodes: [
        { id: "srf-mcp", kind: "surface", parent_id: "p-x" },
        { id: "auth-1", kind: "auth_scheme", parent_id: "p-x" },
      ],
      claims: [],
      edges: [
        {
          kind: "auth_requires",
          from_node_id: "srf-mcp",
          to_node_id: "auth-1",
          rationale: "mcp metadata",
        },
      ],
    };
    persistExtraction(graph.db, ext, { now: fixedNow });
    const e = graph.db
      .prepare("SELECT id, source_id, rationale FROM edges")
      .get() as { id: string; source_id: string; rationale: string };
    expect(e.source_id).toBe("src-c");
    expect(e.id).toMatch(/.+/);
    expect(e.rationale).toBe("mcp metadata");
  });
});
