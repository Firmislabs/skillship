import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractMcpWellKnown } from "../../src/extractors/mcpWellKnown.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/mcp-well-known/sample.json"),
);

function fakeSource(): SourceNode {
  return {
    id: "src-mcp-wk",
    kind: "source",
    surface: "mcp",
    url: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
    content_type: "application/json",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-mcp-wk.json",
  };
}

describe("extractMcpWellKnown", () => {
  test("emits one surface and one auth_scheme node", () => {
    const result = extractMcpWellKnown({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const surfaces = result.nodes.filter((n) => n.kind === "surface");
    const auths = result.nodes.filter((n) => n.kind === "auth_scheme");
    expect(surfaces).toHaveLength(1);
    expect(auths).toHaveLength(1);
  });

  test("nodes parented to productId", () => {
    const result = extractMcpWellKnown({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    for (const n of result.nodes) {
      expect(n.parent_id).toBe("product-mcp");
    }
  });

  test("base_url claim is attested and matches resource", () => {
    const result = extractMcpWellKnown({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const baseUrl = result.claims.find((c) => c.field === "base_url");
    expect(baseUrl).toBeDefined();
    expect(baseUrl?.value).toBe("https://mcp.example.com/mcp");
    expect(baseUrl?.confidence).toBe("attested");
  });

  test("auth_scheme has type=oauth2 and a flows claim with present fields", () => {
    const result = extractMcpWellKnown({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const type = result.claims.find((c) => c.field === "type");
    expect(type?.value).toBe("oauth2");
    const flows = result.claims.find((c) => c.field === "flows");
    expect(flows).toBeDefined();
    const flowsObj = flows?.value as Record<string, unknown>;
    expect(flowsObj.authorization_servers).toEqual([
      "https://auth.example.com",
    ]);
    expect(flowsObj.scopes).toEqual(["read", "write", "admin"]);
    expect(flowsObj.bearer_methods).toEqual(["header"]);
  });

  test("emits one auth_requires edge from surface to auth_scheme", () => {
    const result = extractMcpWellKnown({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    const surface = result.nodes.find((n) => n.kind === "surface");
    const auth = result.nodes.find((n) => n.kind === "auth_scheme");
    const edges = result.edges.filter((e) => e.kind === "auth_requires");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from_node_id).toBe(surface?.id);
    expect(edges[0]?.to_node_id).toBe(auth?.id);
  });

  test("invalid JSON returns empty extraction with stamp + source_id", () => {
    const result = extractMcpWellKnown({
      bytes: Buffer.from("{ not json"),
      source: fakeSource(),
      productId: "product-mcp",
    });
    expect(result.extractor).toBe("mcp-well-known@1");
    expect(result.source_id).toBe("src-mcp-wk");
    expect(result.nodes).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test("minimal input still emits both nodes with available claims", () => {
    const result = extractMcpWellKnown({
      bytes: Buffer.from(JSON.stringify({ resource: "https://x/mcp" })),
      source: fakeSource(),
      productId: "product-mcp",
    });
    expect(result.nodes.filter((n) => n.kind === "surface")).toHaveLength(1);
    expect(result.nodes.filter((n) => n.kind === "auth_scheme")).toHaveLength(
      1,
    );
    const baseUrl = result.claims.find((c) => c.field === "base_url");
    expect(baseUrl?.value).toBe("https://x/mcp");
    const authServers = result.claims.find(
      (c) => c.field === "authorization_servers",
    );
    expect(authServers).toBeUndefined();
  });

  test("every claim has span_path + valid confidence", () => {
    const result = extractMcpWellKnown({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-mcp",
    });
    for (const c of result.claims) {
      expect(typeof c.span_path).toBe("string");
      expect(["attested", "derived"]).toContain(c.confidence);
    }
  });
});
