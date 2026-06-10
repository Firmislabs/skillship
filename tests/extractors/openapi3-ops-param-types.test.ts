// tests/extractors/openapi3-ops-param-types.test.ts
// TDD RED-first: oneOf/anyOf parameter schema type resolution.
// Covers: ANY branch is {type:"integer"} → claim "integer"; else current behavior.
// Evidence: Listmonk's per_page is oneOf:[integer, string "all"] → today claims "unknown".

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
    surfaceId: "sfc_param_test",
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

function paramClaims(
  claims: ExtractedClaim[],
  nodes: ExtractedNode[],
  paramName: string,
): ExtractedClaim[] {
  const paramId = nodes.find(
    (n) => n.kind === "parameter",
  )?.id;
  if (paramId === undefined) return [];
  return claims.filter((c) => c.node_id === paramId);
}

function findParamNodeByName(
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  name: string,
): string | undefined {
  const paramNodes = nodes.filter((n) => n.kind === "parameter");
  for (const pn of paramNodes) {
    const nameClaim = claims.find(
      (c) => c.node_id === pn.id && c.field === "name" && c.value === name,
    );
    if (nameClaim) return pn.id;
  }
  return undefined;
}

function typeClaimForParam(
  claims: ExtractedClaim[],
  nodes: ExtractedNode[],
  paramName: string,
): string | undefined {
  const paramId = findParamNodeByName(nodes, claims, paramName);
  if (!paramId) return undefined;
  const tc = claims.find((c) => c.node_id === paramId && c.field === "type");
  return typeof tc?.value === "string" ? tc.value : undefined;
}

const BASE_RESPONSES = { "200": { description: "OK" } };

// ============================
// oneOf: integer branch present
// ============================

describe("oneOf parameter type resolution — integer branch", () => {
  test("oneOf:[integer, string] → type claim is 'integer' (Listmonk per_page pattern)", () => {
    // Listmonk's per_page: oneOf:[{type:"integer"},{type:"string",enum:["all"]}]
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "per_page",
          in: "query",
          schema: {
            oneOf: [{ type: "integer" }, { type: "string", enum: ["all"] }],
          },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "per_page");
    expect(t).toBe("integer");
  });

  test("oneOf:[string, integer] (integer last) → type claim is 'integer'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "limit",
          in: "query",
          schema: {
            oneOf: [{ type: "string" }, { type: "integer" }],
          },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "limit");
    expect(t).toBe("integer");
  });

  test("anyOf:[integer, string] → type claim is 'integer'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "count",
          in: "query",
          schema: {
            anyOf: [{ type: "integer" }, { type: "string" }],
          },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "count");
    expect(t).toBe("integer");
  });

  test("oneOf:[integer] single integer branch → type claim is 'integer'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "page",
          in: "query",
          schema: {
            oneOf: [{ type: "integer" }],
          },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "page");
    expect(t).toBe("integer");
  });
});

// ============================
// oneOf: no integer branch
// ============================

describe("oneOf parameter type resolution — no integer branch (current behavior preserved)", () => {
  test("oneOf:[string, boolean] (no integer) → type claim is 'unknown'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "filter",
          in: "query",
          schema: {
            oneOf: [{ type: "string" }, { type: "boolean" }],
          },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "filter");
    expect(t).toBe("unknown");
  });

  test("plain schema with type:string (no oneOf) → still claims 'string'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "cursor",
          in: "query",
          schema: { type: "string" },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "cursor");
    expect(t).toBe("string");
  });

  test("plain schema with type:integer (no oneOf) → still claims 'integer'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "page",
          in: "query",
          schema: { type: "integer" },
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "page");
    expect(t).toBe("integer");
  });

  test("schema with no type and no oneOf/anyOf → claims 'unknown'", () => {
    const { nodes, claims } = runEmit({
      parameters: [
        {
          name: "body",
          in: "query",
          schema: {},
        },
      ],
      responses: BASE_RESPONSES,
    });
    const t = typeClaimForParam(claims, nodes, "body");
    expect(t).toBe("unknown");
  });
});
