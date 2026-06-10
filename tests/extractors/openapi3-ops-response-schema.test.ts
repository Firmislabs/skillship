// tests/extractors/openapi3-ops-response-schema.test.ts
// TDD: RED-first tests for inline response-schema → schema_json claim (Task 6b).
// Covers: inline object schema emits schema_json; $ref schema emits schema_ref only;
// both present: only schema_ref (and no schema_json) since spec uses $ref.

import { describe, expect, test } from "vitest";
import { emitOperation } from "../../src/extractors/openapi3-ops.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
} from "../../src/extractors/types.js";

function runEmit(
  opDef: Record<string, unknown>,
  method = "get",
): {
  nodes: ExtractedNode[];
  claims: ExtractedClaim[];
  edges: ExtractedEdge[];
} {
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];
  emitOperation({
    surfaceId: "sfc_test",
    path: "/items",
    method,
    opDef,
    authIds: new Map(),
    globalSecurity: undefined,
    nodes,
    claims,
    edges,
  });
  return { nodes, claims, edges };
}

function responseClaimsFor(
  claims: ExtractedClaim[],
  nodes: ExtractedNode[],
): ExtractedClaim[] {
  const respIds = new Set(
    nodes.filter((n) => n.kind === "response_shape").map((n) => n.id),
  );
  return claims.filter((c) => respIds.has(c.node_id));
}

describe("pushResponseClaims — inline schema → schema_json claim", () => {
  test("inline object schema with properties emits schema_json claim verbatim", () => {
    const inlineSchema = {
      type: "object",
      properties: {
        data: { type: "array", items: { type: "object" } },
        next_cursor: { type: "string" },
      },
    };
    const { nodes, claims } = runEmit({
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": { schema: inlineSchema },
          },
        },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);

    const schemaJsonClaim = respClaims.find((c) => c.field === "schema_json");
    expect(schemaJsonClaim).toBeDefined();
    expect(schemaJsonClaim?.value).toEqual(inlineSchema);
    expect(schemaJsonClaim?.confidence).toBe("attested");

    // Must NOT emit schema_ref when there is no $ref
    const schemaRefClaim = respClaims.find((c) => c.field === "schema_ref");
    expect(schemaRefClaim).toBeUndefined();
  });

  test("span_path for schema_json is consistent with sibling claims (ends with .schema)", () => {
    const inlineSchema = { type: "object", properties: { items: { type: "array" } } };
    const { nodes, claims } = runEmit({
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": { schema: inlineSchema },
          },
        },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);
    const schemaJsonClaim = respClaims.find((c) => c.field === "schema_json");
    expect(schemaJsonClaim?.span_path).toMatch(/\.schema$/);
  });

  test("$ref schema emits schema_ref only — no schema_json", () => {
    const { nodes, claims } = runEmit({
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ItemList" },
            },
          },
        },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);

    const schemaRefClaim = respClaims.find((c) => c.field === "schema_ref");
    expect(schemaRefClaim).toBeDefined();
    expect(schemaRefClaim?.value).toBe("#/components/schemas/ItemList");

    const schemaJsonClaim = respClaims.find((c) => c.field === "schema_json");
    expect(schemaJsonClaim).toBeUndefined();
  });

  test("inline schema that also has a $ref emits schema_ref (ref wins; no schema_json)", () => {
    // OAS allows a schema to have both $ref and additional keywords (3.1 allOf merging),
    // but our contract is: if $ref is present it wins and we don't emit schema_json.
    const { nodes, claims } = runEmit({
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: {
                $ref: "#/components/schemas/ItemList",
                type: "object",
                properties: { data: { type: "array" } },
              },
            },
          },
        },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);
    const schemaRefClaim = respClaims.find((c) => c.field === "schema_ref");
    expect(schemaRefClaim?.value).toBe("#/components/schemas/ItemList");
    const schemaJsonClaim = respClaims.find((c) => c.field === "schema_json");
    expect(schemaJsonClaim).toBeUndefined();
  });

  test("no schema at all produces neither schema_ref nor schema_json", () => {
    const { nodes, claims } = runEmit({
      responses: {
        "200": { description: "OK" },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);
    expect(respClaims.find((c) => c.field === "schema_ref")).toBeUndefined();
    expect(respClaims.find((c) => c.field === "schema_json")).toBeUndefined();
  });

  test("non-object inline schema (type: array) does not emit schema_json", () => {
    // Only object schemas with properties are useful for pagination-detect; skip others.
    const { nodes, claims } = runEmit({
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": {
              schema: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);
    expect(respClaims.find((c) => c.field === "schema_json")).toBeUndefined();
  });

  test("object-like schema without explicit type keyword emits schema_json (OAS 3.1 — type:object optional when properties present)", () => {
    // OAS 3.1 makes `type: object` optional when `properties` is present.
    // Real specs commonly omit it. The extractor must still emit schema_json.
    const inlineSchema = {
      properties: {
        data: { type: "array", items: { type: "object" } },
        next_cursor: { type: "string" },
      },
      required: ["data"],
    };
    const { nodes, claims } = runEmit({
      responses: {
        "200": {
          description: "OK",
          content: {
            "application/json": { schema: inlineSchema },
          },
        },
      },
    });

    const respClaims = responseClaimsFor(claims, nodes);
    const schemaJsonClaim = respClaims.find((c) => c.field === "schema_json");
    expect(schemaJsonClaim).toBeDefined();
    expect(schemaJsonClaim?.value).toEqual(inlineSchema);
    expect(schemaJsonClaim?.confidence).toBe("attested");
    // Must NOT emit schema_ref when there is no $ref
    const schemaRefClaim = respClaims.find((c) => c.field === "schema_ref");
    expect(schemaRefClaim).toBeUndefined();
  });
});
