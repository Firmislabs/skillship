import { describe, expect, test } from "vitest";
import { extractGraphql } from "../../src/extractors/graphql.js";
import type { SourceNode } from "../../src/graph/types.js";

function fakeSource(): SourceNode {
  return {
    id: "src-gql-auth",
    kind: "source",
    surface: "rest",
    url: "https://api.example.com/schema.graphql",
    content_type: "application/graphql",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: 100,
    cache_path: "/tmp/src-gql-auth.graphql",
  };
}

describe("extractGraphql — auth_requires edges (Gap 1 closure)", () => {
  test("emits one auth_requires edge per operation to the default bearer auth_scheme", async () => {
    const result = await extractGraphql({
      bytes: Buffer.from(`
        type Query { issues: [String!]! }
        type Mutation { issueCreate(name: String!): String! }
      `, "utf-8"),
      source: fakeSource(),
      productId: "prod-auth-edges",
    });

    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(2);

    const auths = result.nodes.filter((n) => n.kind === "auth_scheme");
    expect(auths).toHaveLength(1);
    const authId = auths[0]!.id;

    const authEdges = result.edges.filter((e) => e.kind === "auth_requires");
    expect(authEdges).toHaveLength(2);
    const fromIds = new Set(authEdges.map((e) => e.from_node_id));
    expect(fromIds).toEqual(new Set(ops.map((o) => o.id)));
    for (const edge of authEdges) {
      expect(edge.to_node_id).toBe(authId);
    }
  });

  test("does not emit auth_requires edges when SDL has no operations", async () => {
    const result = await extractGraphql({
      bytes: Buffer.from(`type Foo { x: String }`, "utf-8"),
      source: fakeSource(),
      productId: "prod-noop-edges",
    });
    expect(result.edges).toEqual([]);
  });
});
