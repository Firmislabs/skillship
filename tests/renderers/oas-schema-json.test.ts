// tests/renderers/oas-schema-json.test.ts
// TDD: RED-first tests for schema_json claim projection in buildResponses (Task 6b).
// Covers: schema_json present → verbatim schema in response; absent → stub { type: "object" };
// both schema_ref and schema_json → $ref wins.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { renderSyntheticOpenApi } from "../../src/renderers/oas.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

const NOW_TS = "2026-06-10T00:00:00.000Z";
const OVERLAY = CodegenOverlaySchema.parse({});

function seedOp(
  db: GraphDb["db"],
  opts: {
    productId: string;
    surfaceId: string;
    opId: string;
    respId: string;
    sourceId: string;
    schemaRef?: string;
    schemaJson?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.sourceId,
    "rest",
    "https://schemajson.example/openapi.yaml",
    "application/openapi+yaml",
    NOW_TS,
    0,
    ".skillship/sources/fake.yaml",
  );
  db.prepare(
    `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.surfaceId, "surface", opts.productId, NOW_TS, NOW_TS);
  db.prepare(
    `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.opId, "operation", opts.surfaceId, NOW_TS, NOW_TS);
  db.prepare(
    `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(opts.respId, "response_shape", opts.opId, NOW_TS, NOW_TS);

  const insertClaim = (
    nodeId: string,
    field: string,
    value: unknown,
    claimId: string,
  ): void => {
    db.prepare(
      `INSERT INTO claims
         (id, node_id, field, value_json, source_id, extractor, extracted_at,
          span_start, span_end, span_path, confidence, chosen, rejection_rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      claimId,
      nodeId,
      field,
      JSON.stringify(value),
      opts.sourceId,
      "openapi@3",
      NOW_TS,
      null,
      null,
      null,
      "attested",
      0,
      null,
    );
  };

  insertClaim(opts.opId, "method", "GET", `cl_${opts.opId}_method`);
  insertClaim(opts.opId, "path_or_name", "/items", `cl_${opts.opId}_path`);
  insertClaim(opts.respId, "status_code", 200, `cl_${opts.respId}_status`);
  insertClaim(
    opts.respId,
    "content_type",
    "application/json",
    `cl_${opts.respId}_ct`,
  );

  if (opts.schemaRef !== undefined) {
    insertClaim(opts.respId, "schema_ref", opts.schemaRef, `cl_${opts.respId}_ref`);
  }
  if (opts.schemaJson !== undefined) {
    insertClaim(
      opts.respId,
      "schema_json",
      opts.schemaJson,
      `cl_${opts.respId}_json`,
    );
  }
}

describe("buildResponses — schema_json claim projection", () => {
  let tmp: string;
  let graph: GraphDb;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-oas-sj-"));
    graph = openGraph(join(tmp, "g.db"));
  });
  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("schema_json claim projects verbatim as response schema (inline object)", () => {
    const inlineSchema = {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "object" } },
        next_cursor: { type: "string" },
      },
    };
    seedOp(graph.db, {
      productId: "p-sj-inline",
      surfaceId: "sfc_sj_inline",
      opId: "op_sj_inline",
      respId: "rsp_sj_inline",
      sourceId: "src_sj_inline",
      schemaJson: inlineSchema,
    });

    const doc = JSON.parse(
      renderSyntheticOpenApi({
        db: graph.db,
        productId: "p-sj-inline",
        productName: "schemajson.example",
        overlay: OVERLAY,
      }),
    ) as {
      paths: Record<
        string,
        { get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }
      >;
    };

    const schema =
      doc.paths["/items"]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(schema).toEqual(inlineSchema);
  });

  test("without schema_json or schema_ref, response schema is stub { type: 'object' } (unchanged behaviour)", () => {
    seedOp(graph.db, {
      productId: "p-sj-stub",
      surfaceId: "sfc_sj_stub",
      opId: "op_sj_stub",
      respId: "rsp_sj_stub",
      sourceId: "src_sj_stub",
    });

    const doc = JSON.parse(
      renderSyntheticOpenApi({
        db: graph.db,
        productId: "p-sj-stub",
        productName: "schemajson.example",
        overlay: OVERLAY,
      }),
    ) as {
      paths: Record<
        string,
        { get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }
      >;
    };

    const schema =
      doc.paths["/items"]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(schema).toEqual({ type: "object" });
  });

  test("nested $ref inside schema_json payload registers stubs in components.schemas (no dangling refs)", () => {
    // Fix 1: An inline schema_json with nested component refs like
    // { type:"object", properties:{ data:{ type:"array", items:{ $ref:"#/components/schemas/Item" } }, next_cursor:{type:"string"} } }
    // must cause "Item" to be stubbed in components.schemas — otherwise the OAS doc is invalid
    // (Fern and validators hard-fail on dangling $refs).
    const inlineSchema = {
      type: "object",
      properties: {
        data: { type: "array", items: { $ref: "#/components/schemas/Item" } },
        next_cursor: { type: "string" },
      },
    };
    seedOp(graph.db, {
      productId: "p-sj-nested",
      surfaceId: "sfc_sj_nested",
      opId: "op_sj_nested",
      respId: "rsp_sj_nested",
      sourceId: "src_sj_nested",
      schemaJson: inlineSchema,
    });

    const doc = JSON.parse(
      renderSyntheticOpenApi({
        db: graph.db,
        productId: "p-sj-nested",
        productName: "schemajson.example",
        overlay: OVERLAY,
      }),
    ) as {
      paths: Record<
        string,
        { get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }
      >;
      components: { schemas: Record<string, unknown> };
    };

    // The inline schema must appear verbatim in the response
    const schema =
      doc.paths["/items"]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    expect(schema).toEqual(inlineSchema);

    // "Item" must be stubbed in components.schemas to avoid a dangling $ref
    expect(doc.components.schemas).toHaveProperty("Item");
    expect((doc.components.schemas as Record<string, unknown>)["Item"]).toEqual({ type: "object" });
  });

  test("multiple distinct nested $refs in schema_json each get a stub (dedup, alphabetical order)", () => {
    // Fix 1 dedup: two different nested refs must both appear as stubs, each once.
    const inlineSchema = {
      type: "object",
      properties: {
        items: { type: "array", items: { $ref: "#/components/schemas/Widget" } },
        meta: { $ref: "#/components/schemas/Meta" },
        next_cursor: { type: "string" },
      },
    };
    seedOp(graph.db, {
      productId: "p-sj-multi",
      surfaceId: "sfc_sj_multi",
      opId: "op_sj_multi",
      respId: "rsp_sj_multi",
      sourceId: "src_sj_multi",
      schemaJson: inlineSchema,
    });

    const doc = JSON.parse(
      renderSyntheticOpenApi({
        db: graph.db,
        productId: "p-sj-multi",
        productName: "schemajson.example",
        overlay: OVERLAY,
      }),
    ) as {
      components: { schemas: Record<string, unknown> };
    };

    // Both nested refs must be stubbed
    expect(doc.components.schemas).toHaveProperty("Meta");
    expect(doc.components.schemas).toHaveProperty("Widget");
    expect((doc.components.schemas as Record<string, unknown>)["Meta"]).toEqual({ type: "object" });
    expect((doc.components.schemas as Record<string, unknown>)["Widget"]).toEqual({ type: "object" });
  });

  test("schema_ref wins over schema_json when both are present ($ref takes precedence)", () => {
    const inlineSchema = {
      type: "object",
      properties: { data: { type: "array" } },
    };
    seedOp(graph.db, {
      productId: "p-sj-both",
      surfaceId: "sfc_sj_both",
      opId: "op_sj_both",
      respId: "rsp_sj_both",
      sourceId: "src_sj_both",
      schemaRef: "#/components/schemas/ItemList",
      schemaJson: inlineSchema,
    });

    const doc = JSON.parse(
      renderSyntheticOpenApi({
        db: graph.db,
        productId: "p-sj-both",
        productName: "schemajson.example",
        overlay: OVERLAY,
      }),
    ) as {
      paths: Record<
        string,
        { get: { responses: Record<string, { content: Record<string, { schema: Record<string, unknown> }> }> } }
      >;
      components: { schemas: Record<string, unknown> };
    };

    const schema =
      doc.paths["/items"]?.get?.responses?.["200"]?.content?.["application/json"]
        ?.schema;
    // $ref must be present, inline properties must NOT be
    expect(schema?.["$ref"]).toBe("#/components/schemas/ItemList");
    expect(schema?.["properties"]).toBeUndefined();
    // The stub entry for ItemList must appear in components.schemas
    expect(doc.components.schemas).toHaveProperty("ItemList");
  });
});
