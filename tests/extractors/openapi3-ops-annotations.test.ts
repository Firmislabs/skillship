// tests/extractors/openapi3-ops-annotations.test.ts
// TDD RED-first: annotation claims from x-skillship-annotations extension.
// Covers: destructive/readOnly/idempotent boolean fields; unknown keys ignored;
// non-boolean values ignored; ops without extension emit no annotation claims.

import { describe, expect, test } from "vitest";
import { emitOperation } from "../../src/extractors/openapi3-ops.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
} from "../../src/extractors/types.js";

function runEmit(
  opDef: Record<string, unknown>,
  method = "post",
): {
  nodes: ExtractedNode[];
  claims: ExtractedClaim[];
  edges: ExtractedEdge[];
} {
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];
  emitOperation({
    surfaceId: "sfc_ann_test",
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

function opClaimsFor(claims: ExtractedClaim[], nodes: ExtractedNode[]): ExtractedClaim[] {
  const opId = nodes.find((n) => n.kind === "operation")?.id;
  if (opId === undefined) return [];
  return claims.filter((c) => c.node_id === opId);
}

describe("pushAnnotationClaims — x-skillship-annotations ingestion", () => {
  test("destructive:true emits is_destructive claim with attested confidence", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { destructive: true },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    const claim = opClaims.find((c) => c.field === "is_destructive");
    expect(claim).toBeDefined();
    expect(claim?.value).toBe(true);
    expect(claim?.confidence).toBe("attested");
  });

  test("span_path for is_destructive ends with .x-skillship-annotations", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { destructive: true },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    const claim = opClaims.find((c) => c.field === "is_destructive");
    expect(claim?.span_path).toMatch(/\.x-skillship-annotations$/);
  });

  test("readOnly:false emits is_read_only claim with value false", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { readOnly: false },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    const claim = opClaims.find((c) => c.field === "is_read_only");
    expect(claim).toBeDefined();
    expect(claim?.value).toBe(false);
    expect(claim?.confidence).toBe("attested");
  });

  test("idempotent:true emits is_idempotent claim", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { idempotent: true },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    const claim = opClaims.find((c) => c.field === "is_idempotent");
    expect(claim).toBeDefined();
    expect(claim?.value).toBe(true);
    expect(claim?.confidence).toBe("attested");
  });

  test("all three boolean keys together each emit one claim", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { destructive: true, readOnly: false, idempotent: false },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    expect(opClaims.find((c) => c.field === "is_destructive")?.value).toBe(true);
    expect(opClaims.find((c) => c.field === "is_read_only")?.value).toBe(false);
    expect(opClaims.find((c) => c.field === "is_idempotent")?.value).toBe(false);
  });

  test("unknown keys in extension are silently ignored", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { destructive: true, unknownKey: "ignored", anotherKey: 42 },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    // is_destructive is present
    expect(opClaims.find((c) => c.field === "is_destructive")).toBeDefined();
    // no claims for unknown keys
    expect(opClaims.find((c) => c.field === "unknownKey")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "anotherKey")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_unknownKey")).toBeUndefined();
  });

  test("non-boolean values for known keys are silently ignored", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { destructive: "yes", readOnly: 1, idempotent: null },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    expect(opClaims.find((c) => c.field === "is_destructive")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_read_only")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_idempotent")).toBeUndefined();
  });

  test("op without x-skillship-annotations emits no annotation claims", () => {
    const { nodes, claims } = runEmit({
      summary: "No annotations here",
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    expect(opClaims.find((c) => c.field === "is_destructive")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_read_only")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_idempotent")).toBeUndefined();
  });

  test("x-skillship-annotations with non-object value is ignored entirely", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": "invalid",
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    expect(opClaims.find((c) => c.field === "is_destructive")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_read_only")).toBeUndefined();
    expect(opClaims.find((c) => c.field === "is_idempotent")).toBeUndefined();
  });

  test("destructive:false emits is_destructive claim with value false", () => {
    const { nodes, claims } = runEmit({
      "x-skillship-annotations": { destructive: false },
      responses: { "200": { description: "OK" } },
    });

    const opClaims = opClaimsFor(claims, nodes);
    const claim = opClaims.find((c) => c.field === "is_destructive");
    expect(claim).toBeDefined();
    expect(claim?.value).toBe(false);
  });
});
