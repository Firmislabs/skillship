import { describe, expect, test } from "vitest";
import { emitOperation } from "../../src/extractors/openapi3-ops.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
} from "../../src/extractors/types.js";

function runEmit(opDef: Record<string, unknown>): {
  nodes: ExtractedNode[];
  claims: ExtractedClaim[];
  edges: ExtractedEdge[];
} {
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];
  emitOperation({
    surfaceId: "sfc_test",
    path: "/projects",
    method: "post",
    opDef,
    authIds: new Map(),
    nodes,
    claims,
    edges,
  });
  return { nodes, claims, edges };
}

describe("emitOperation — body parameter projection (Gap 2 closure)", () => {
  test("emits a parameter node with location='body' for an op with a requestBody $ref", () => {
    const { nodes, claims } = runEmit({
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ProjectInput" },
          },
        },
      },
      responses: { "201": { description: "Created" } },
    });

    const params = nodes.filter((n) => n.kind === "parameter");
    expect(params).toHaveLength(1);
    const paramId = params[0]!.id;

    const locationClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "location",
    );
    expect(locationClaim?.value).toBe("body");

    const nameClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "name",
    );
    expect(nameClaim?.value).toBe("body");

    const requiredClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "required",
    );
    expect(requiredClaim?.value).toBe(true);

    const refClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "schema_ref",
    );
    expect(refClaim?.value).toBe("#/components/schemas/ProjectInput");

    const ctClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "content_type",
    );
    expect(ctClaim?.value).toBe("application/json");
  });

  test("defaults required to false when requestBody.required is absent", () => {
    const { claims, nodes } = runEmit({
      requestBody: {
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
      responses: { "200": { description: "OK" } },
    });
    const paramId = nodes.find((n) => n.kind === "parameter")!.id;
    const requiredClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "required",
    );
    expect(requiredClaim?.value).toBe(false);
  });

  test("does not emit schema_ref claim when body has no $ref", () => {
    const { claims, nodes } = runEmit({
      requestBody: {
        required: true,
        content: {
          "application/json": { schema: { type: "object" } },
        },
      },
      responses: { "200": { description: "OK" } },
    });
    const paramId = nodes.find((n) => n.kind === "parameter")!.id;
    const refClaim = claims.find(
      (c) => c.node_id === paramId && c.field === "schema_ref",
    );
    expect(refClaim).toBeUndefined();
  });

  test("emits no body parameter when there is no requestBody", () => {
    const { nodes } = runEmit({
      responses: { "200": { description: "OK" } },
    });
    expect(nodes.filter((n) => n.kind === "parameter")).toEqual([]);
  });

  test("emits no body parameter when content lacks application/json", () => {
    const { nodes } = runEmit({
      requestBody: {
        required: true,
        content: {
          "text/plain": { schema: { type: "string" } },
        },
      },
      responses: { "200": { description: "OK" } },
    });
    expect(nodes.filter((n) => n.kind === "parameter")).toEqual([]);
  });
});
