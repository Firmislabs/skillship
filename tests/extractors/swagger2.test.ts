import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  convertSwagger2ToOpenapi3,
  extractSwagger2,
} from "../../src/extractors/swagger2.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/swagger2/gotrue-like.json"),
);

function fakeSource(): SourceNode {
  return {
    id: "src-swagger",
    kind: "source",
    surface: "rest",
    url: "https://gotrue.example.com/swagger.json",
    content_type: "application/json",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-swagger.json",
  };
}

describe("convertSwagger2ToOpenapi3", () => {
  test("converts swagger:2.0 to openapi:3.0.x", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    expect(out.openapi?.startsWith("3.")).toBe(true);
    expect((out as { swagger?: string }).swagger).toBeUndefined();
  });

  test("composes host + basePath + schemes into servers", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    expect(out.servers).toEqual([{ url: "https://gotrue.example.com/" }]);
  });

  test("moves body parameter into requestBody and drops it from parameters", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    const post = out.paths!["/token"]!.post!;
    const params = post.parameters as { in: string; name: string }[];
    expect(params.find((p) => p.in === "body")).toBeUndefined();
    expect(params.some((p) => p.name === "grant_type")).toBe(true);
    expect(post.requestBody).toBeDefined();
    expect(post.requestBody!.content["application/json"]).toBeDefined();
  });

  test("wraps non-body params' type into schema", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    const post = out.paths!["/token"]!.post!;
    const params = post.parameters as {
      name: string;
      schema?: { type: string };
    }[];
    const grant = params.find((p) => p.name === "grant_type")!;
    expect(grant.schema?.type).toBe("string");
  });

  test("wraps response.schema into content['application/json'].schema", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    const resp = out.paths!["/token"]!.post!.responses!["200"]!;
    expect(resp.content!["application/json"]!.schema).toBeDefined();
  });

  test("moves securityDefinitions to components.securitySchemes", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    expect(out.components?.securitySchemes?.BearerAuth).toBeDefined();
    expect((out as { securityDefinitions?: unknown }).securityDefinitions).toBeUndefined();
  });

  test("rewrites #/definitions/X refs to #/components/schemas/X", () => {
    const doc = JSON.parse(FIXTURE.toString("utf-8"));
    const out = convertSwagger2ToOpenapi3(doc);
    const asText = JSON.stringify(out);
    expect(asText.includes("#/definitions/")).toBe(false);
    expect(asText.includes("#/components/schemas/")).toBe(true);
    expect(out.components?.schemas?.TokenRequest).toBeDefined();
  });
});

describe("extractSwagger2", () => {
  test("emits operations using the openapi@3 extractor path", () => {
    const result = extractSwagger2({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-gotrue",
    });
    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(2);
    expect(result.extractor).toBe("swagger@2");
    expect(result.source_id).toBe("src-swagger");
  });

  test("propagates auth scheme from securityDefinitions via converter", () => {
    const result = extractSwagger2({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-gotrue",
    });
    const auths = result.nodes.filter((n) => n.kind === "auth_scheme");
    expect(auths).toHaveLength(1);
    const authEdges = result.edges.filter((e) => e.kind === "auth_requires");
    expect(authEdges.length).toBeGreaterThanOrEqual(1);
  });
});
