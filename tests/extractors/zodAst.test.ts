import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractZodAst } from "../../src/extractors/zodAst.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/zod-ast/mcp-tools.ts"),
);

function fakeSource(): SourceNode {
  return {
    id: "src-zod",
    kind: "source",
    surface: "mcp",
    url: "https://github.com/example/repo/blob/main/mcp-tools.ts",
    content_type: "application/typescript",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-zod.ts",
  };
}

describe("extractZodAst", () => {
  test("emits exactly one surface node", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const surfaces = result.nodes.filter((n) => n.kind === "surface");
    expect(surfaces).toHaveLength(1);
  });

  test("emits exactly 2 operation nodes (skips malformed and unexported)", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(2);
  });

  test("create_issue annotation claims map to MCP hint fields", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const opNames = result.claims
      .filter((c) => c.field === "path_or_name")
      .map((c) => ({ id: c.node_id, value: c.value }));
    const createOp = opNames.find((o) => o.value === "create_issue");
    expect(createOp).toBeDefined();
    const hints = result.claims.filter((c) => c.node_id === createOp?.id);
    const get = (field: string): unknown =>
      hints.find((h) => h.field === field)?.value;
    expect(get("is_destructive")).toBe(false);
    expect(get("is_idempotent")).toBe(false);
    expect(get("is_read_only")).toBe(false);
    expect(get("opens_world")).toBe(true);
  });

  test("list_issues annotations: read_only=true, idempotent=true", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const opNames = result.claims
      .filter((c) => c.field === "path_or_name")
      .map((c) => ({ id: c.node_id, value: c.value }));
    const listOp = opNames.find((o) => o.value === "list_issues");
    expect(listOp).toBeDefined();
    const hints = result.claims.filter((c) => c.node_id === listOp?.id);
    const get = (field: string): unknown =>
      hints.find((h) => h.field === field)?.value;
    expect(get("is_read_only")).toBe(true);
    expect(get("is_idempotent")).toBe(true);
  });

  test("create_issue parameters: title required, body+labels optional", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const createOpId = result.claims.find(
      (c) => c.field === "path_or_name" && c.value === "create_issue",
    )?.node_id;
    expect(createOpId).toBeDefined();
    const paramNodes = result.nodes.filter(
      (n) => n.kind === "parameter" && n.parent_id === createOpId,
    );
    expect(paramNodes).toHaveLength(3);
    const byParamName = new Map<string, { type: unknown; required: unknown }>();
    for (const p of paramNodes) {
      const name = result.claims.find(
        (c) => c.node_id === p.id && c.field === "name",
      )?.value;
      const type = result.claims.find(
        (c) => c.node_id === p.id && c.field === "type",
      )?.value;
      const required = result.claims.find(
        (c) => c.node_id === p.id && c.field === "required",
      )?.value;
      if (typeof name === "string") byParamName.set(name, { type, required });
    }
    expect(byParamName.get("title")).toEqual({
      type: "string",
      required: true,
    });
    expect(byParamName.get("body")).toEqual({
      type: "string",
      required: false,
    });
    expect(byParamName.get("labels")).toEqual({
      type: "array",
      required: false,
    });
  });

  test("structural edges: has_operation per op, has_parameter per param", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const opCount = result.nodes.filter((n) => n.kind === "operation").length;
    const paramCount = result.nodes.filter((n) => n.kind === "parameter").length;
    const hasOpEdges = result.edges.filter((e) => e.kind === "has_operation");
    const hasParamEdges = result.edges.filter(
      (e) => e.kind === "has_parameter",
    );
    expect(hasOpEdges).toHaveLength(opCount);
    expect(hasParamEdges).toHaveLength(paramCount);
  });

  test("stamp + every claim has span_path + valid confidence", () => {
    const result = extractZodAst({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    expect(result.extractor).toBe("zod-ast@1");
    for (const c of result.claims) {
      expect(typeof c.span_path).toBe("string");
      expect(["attested", "derived"]).toContain(c.confidence);
    }
  });
});
