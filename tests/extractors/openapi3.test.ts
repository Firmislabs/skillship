import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractOpenApi3 } from "../../src/extractors/openapi3.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/openapi3");

function readFixture(name: string): Buffer {
  return readFileSync(join(FIXTURE_DIR, name));
}

function fakeSource(overrides: Partial<SourceNode> = {}): SourceNode {
  return {
    id: "src-abc",
    kind: "source",
    surface: "rest",
    url: "https://api.example.com/openapi.yaml",
    content_type: "application/yaml",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: 1024,
    cache_path: "/tmp/src-abc.yaml",
    ...overrides,
  };
}

describe("extractOpenApi3", () => {
  const bytes = readFixture("minimal.yaml");

  test("creates one REST surface node parented to the product", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const surfaces = result.nodes.filter((n) => n.kind === "surface");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.parent_id).toBe("product-test");
  });

  test("emits an operation node per (path, method) pair", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(2);
  });

  test("emits method + path_or_name + summary claims with JSONPath span", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const ops = result.nodes.filter((n) => n.kind === "operation");
    const getOp = ops.find((n) => {
      const m = result.claims.find(
        (c) => c.node_id === n.id && c.field === "method",
      );
      return m?.value === "GET";
    });
    expect(getOp).toBeDefined();

    const methodClaim = result.claims.find(
      (c) => c.node_id === getOp!.id && c.field === "method",
    );
    expect(methodClaim?.value).toBe("GET");
    expect(methodClaim?.span_path).toBe('$.paths["/projects"].get');
    expect(methodClaim?.confidence).toBe("attested");

    const pathClaim = result.claims.find(
      (c) => c.node_id === getOp!.id && c.field === "path_or_name",
    );
    expect(pathClaim?.value).toBe("/projects");

    const summaryClaim = result.claims.find(
      (c) => c.node_id === getOp!.id && c.field === "summary",
    );
    expect(summaryClaim?.value).toBe("List projects");
    expect(summaryClaim?.span_path).toBe('$.paths["/projects"].get.summary');
  });

  test("emits parameter nodes with location + required + type claims", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const params = result.nodes.filter((n) => n.kind === "parameter");
    expect(params.length).toBeGreaterThanOrEqual(2);

    const limitParam = params.find((p) => {
      const nameClaim = result.claims.find(
        (c) => c.node_id === p.id && c.field === "name",
      );
      return nameClaim?.value === "limit";
    });
    expect(limitParam).toBeDefined();

    const locClaim = result.claims.find(
      (c) => c.node_id === limitParam!.id && c.field === "location",
    );
    expect(locClaim?.value).toBe("query");

    const reqClaim = result.claims.find(
      (c) => c.node_id === limitParam!.id && c.field === "required",
    );
    expect(reqClaim?.value).toBe(false);

    const typeClaim = result.claims.find(
      (c) => c.node_id === limitParam!.id && c.field === "type",
    );
    expect(typeClaim?.value).toBe("integer");
  });

  test("emits response_shape nodes with status_code + content_type claims", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const shapes = result.nodes.filter((n) => n.kind === "response_shape");
    expect(shapes.length).toBeGreaterThanOrEqual(3);

    const two00 = shapes.find((s) => {
      const status = result.claims.find(
        (c) => c.node_id === s.id && c.field === "status_code",
      );
      return status?.value === 200;
    });
    expect(two00).toBeDefined();
    const contentType = result.claims.find(
      (c) => c.node_id === two00!.id && c.field === "content_type",
    );
    expect(contentType?.value).toBe("application/json");
  });

  test("emits auth_scheme node + auth_requires edge when operation has security", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const auths = result.nodes.filter((n) => n.kind === "auth_scheme");
    expect(auths).toHaveLength(1);
    expect(auths[0]!.parent_id).toBe("product-test");

    const typeClaim = result.claims.find(
      (c) => c.node_id === auths[0]!.id && c.field === "type",
    );
    expect(typeClaim?.value).toBe("bearer");

    const authEdges = result.edges.filter((e) => e.kind === "auth_requires");
    expect(authEdges.length).toBeGreaterThanOrEqual(2);
    expect(authEdges.every((e) => e.to_node_id === auths[0]!.id)).toBe(true);
  });

  test("emits structural edges: exposes, has_operation, has_parameter, returns", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource(),
      productId: "product-test",
    });

    const surface = result.nodes.find((n) => n.kind === "surface")!;
    const ops = result.nodes.filter((n) => n.kind === "operation");

    expect(
      result.edges.some(
        (e) =>
          e.kind === "exposes" &&
          e.from_node_id === "product-test" &&
          e.to_node_id === surface.id,
      ),
    ).toBe(true);

    expect(
      result.edges.filter(
        (e) => e.kind === "has_operation" && e.from_node_id === surface.id,
      ),
    ).toHaveLength(ops.length);

    expect(
      result.edges.some((e) => e.kind === "has_parameter"),
    ).toBe(true);

    expect(result.edges.some((e) => e.kind === "returns")).toBe(true);
  });

  test("stamps every claim with source_id, extractor, and confidence", () => {
    const result = extractOpenApi3({
      bytes,
      source: fakeSource({ id: "deadbeef" }),
      productId: "product-test",
    });

    expect(result.extractor).toBe("openapi@3");
    expect(result.source_id).toBe("deadbeef");
    expect(result.claims.length).toBeGreaterThan(0);
    for (const claim of result.claims) {
      expect(["attested", "derived"]).toContain(claim.confidence);
      expect(typeof claim.span_path === "string").toBe(true);
    }
  });

  test("accepts JSON input by sniffing content-type", () => {
    const jsonBytes = Buffer.from(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "J", version: "1" },
        paths: {
          "/ping": {
            get: { summary: "Ping", responses: { "200": { description: "ok" } } },
          },
        },
      }),
    );
    const result = extractOpenApi3({
      bytes: jsonBytes,
      source: fakeSource({ content_type: "application/json" }),
      productId: "product-test",
    });

    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(1);
    const summary = result.claims.find(
      (c) => c.node_id === ops[0]!.id && c.field === "summary",
    );
    expect(summary?.value).toBe("Ping");
  });

  test("emits request_example claim when requestBody has an example", () => {
    const jsonBytes = Buffer.from(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: {
          "/widgets": {
            post: {
              summary: "Create widget",
              requestBody: {
                content: {
                  "application/json": {
                    example: { name: "gizmo", count: 3 },
                  },
                },
              },
              responses: { "201": { description: "ok" } },
            },
          },
        },
      }),
    );
    const result = extractOpenApi3({
      bytes: jsonBytes,
      source: fakeSource({ content_type: "application/json" }),
      productId: "product-test",
    });
    const op = result.nodes.find((n) => n.kind === "operation");
    expect(op).toBeDefined();
    const ex = result.claims.find(
      (c) => c.node_id === op?.id && c.field === "request_example",
    );
    expect(ex).toBeDefined();
    expect(ex?.value).toEqual({ name: "gizmo", count: 3 });
    expect(ex?.confidence).toBe("attested");
  });

  test("emits response example claim when response content has an example", () => {
    const jsonBytes = Buffer.from(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: {
          "/widgets/{id}": {
            get: {
              summary: "Get widget",
              responses: {
                "200": {
                  description: "ok",
                  content: {
                    "application/json": {
                      example: { id: "w_1", name: "gizmo" },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    );
    const result = extractOpenApi3({
      bytes: jsonBytes,
      source: fakeSource({ content_type: "application/json" }),
      productId: "product-test",
    });
    const resp = result.nodes.find((n) => n.kind === "response_shape");
    expect(resp).toBeDefined();
    const ex = result.claims.find(
      (c) => c.node_id === resp?.id && c.field === "example",
    );
    expect(ex).toBeDefined();
    expect(ex?.value).toEqual({ id: "w_1", name: "gizmo" });
  });

  test("emits enum_values claim when parameter schema has enum", () => {
    const jsonBytes = Buffer.from(
      JSON.stringify({
        openapi: "3.0.3",
        info: { title: "T", version: "1" },
        paths: {
          "/widgets": {
            get: {
              summary: "List",
              parameters: [
                {
                  name: "status",
                  in: "query",
                  schema: { type: "string", enum: ["open", "closed", "draft"] },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      }),
    );
    const result = extractOpenApi3({
      bytes: jsonBytes,
      source: fakeSource({ content_type: "application/json" }),
      productId: "product-test",
    });
    const param = result.nodes.find((n) => n.kind === "parameter");
    expect(param).toBeDefined();
    const enumClaim = result.claims.find(
      (c) => c.node_id === param?.id && c.field === "enum_values",
    );
    expect(enumClaim).toBeDefined();
    expect(enumClaim?.value).toEqual(["open", "closed", "draft"]);
  });

  test("produces deterministic node IDs across calls", () => {
    const a = extractOpenApi3({
      bytes,
      source: fakeSource({ id: "src-1" }),
      productId: "product-test",
    });
    const b = extractOpenApi3({
      bytes,
      source: fakeSource({ id: "src-2" }),
      productId: "product-test",
    });

    const idsA = a.nodes.map((n) => n.id).sort();
    const idsB = b.nodes.map((n) => n.id).sort();
    expect(idsA).toEqual(idsB);
  });
});
