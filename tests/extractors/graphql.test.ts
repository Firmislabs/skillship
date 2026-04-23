import { describe, expect, test } from "vitest"
import { extractGraphql } from "../../src/extractors/graphql.js"
import type { SourceNode } from "../../src/graph/types.js"

function fakeSource(id = "src-gql-1"): SourceNode {
  return {
    id,
    kind: "source",
    surface: "rest",
    url: "https://api.example.com/schema.graphql",
    content_type: "application/graphql",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: 100,
    cache_path: `/tmp/${id}.graphql`,
  }
}

function sdl(src: string): Buffer {
  return Buffer.from(src, "utf-8")
}

describe("extractGraphql", () => {
  test("simple Query type emits one Operation per field", async () => {
    const src = `
      type Query {
        users: [User!]!
        user(id: ID!): User
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-1",
    })
    const ops = result.nodes.filter(n => n.kind === "operation")
    expect(ops).toHaveLength(2)
    const methods = result.claims
      .filter(c => c.field === "method")
      .map(c => c.value)
    expect(methods).toEqual(["QUERY", "QUERY"])
    const names = result.claims
      .filter(c => c.field === "path_or_name")
      .map(c => c.value)
      .sort()
    expect(names).toEqual(["user", "users"])
  })

  test("Mutation type emits MUTATION method", async () => {
    const src = `
      type Mutation {
        createUser(name: String!): User!
        deleteUser(id: ID!): Boolean!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-2",
    })
    const ops = result.nodes.filter(n => n.kind === "operation")
    expect(ops).toHaveLength(2)
    const methods = result.claims
      .filter(c => c.field === "method")
      .map(c => c.value)
    expect(methods).toEqual(["MUTATION", "MUTATION"])
  })

  test("Mutation and Query together each have correct method", async () => {
    const src = `
      type Query {
        issues: [Issue!]!
      }
      type Mutation {
        issueCreate(input: IssueCreateInput!): Issue!
        issueUpdate(id: ID!, input: IssueUpdateInput!): Issue!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-3",
    })
    const ops = result.nodes.filter(n => n.kind === "operation")
    expect(ops).toHaveLength(3)
    const byName = new Map(
      result.claims
        .filter(c => c.field === "path_or_name")
        .map(c => [c.value as string, c.node_id]),
    )
    const methodFor = (name: string): string | undefined => {
      const nodeId = byName.get(name)
      return result.claims.find(
        c => c.field === "method" && c.node_id === nodeId,
      )?.value as string | undefined
    }
    expect(methodFor("issues")).toBe("QUERY")
    expect(methodFor("issueCreate")).toBe("MUTATION")
    expect(methodFor("issueUpdate")).toBe("MUTATION")
  })

  test("Subscription type emits SUBSCRIPTION method", async () => {
    const src = `
      type Subscription {
        issueCreated: Issue!
        commentAdded(issueId: ID!): Comment!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-4",
    })
    const methods = result.claims
      .filter(c => c.field === "method")
      .map(c => c.value)
    expect(methods).toEqual(["SUBSCRIPTION", "SUBSCRIPTION"])
  })

  test("field with arguments populates params claim", async () => {
    const src = `
      type Query {
        issue(id: ID!, teamId: String): Issue
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-5",
    })
    const params = result.claims.find(c => c.field === "params")
    expect(params).toBeDefined()
    const val = params?.value as string[]
    expect(val).toContain("id: ID!")
    expect(val).toContain("teamId: String")
  })

  test("field descriptions populate summary claim", async () => {
    const src = `
      type Query {
        """List all issues in the workspace."""
        issues: [Issue!]!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-6",
    })
    const summary = result.claims.find(c => c.field === "summary")
    expect(summary).toBeDefined()
    expect(summary?.value).toBe("List all issues in the workspace.")
  })

  test("extend type Query fields are merged with base Query fields", async () => {
    const src = `
      type Query {
        issues: [Issue!]!
      }
      extend type Query {
        teams: [Team!]!
        projects: [Project!]!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-7",
    })
    const ops = result.nodes.filter(n => n.kind === "operation")
    expect(ops).toHaveLength(3)
    const names = result.claims
      .filter(c => c.field === "path_or_name")
      .map(c => c.value as string)
      .sort()
    expect(names).toEqual(["issues", "projects", "teams"])
  })

  test("empty SDL returns empty extraction without throwing", async () => {
    const result = await extractGraphql({
      bytes: sdl(""),
      source: fakeSource("src-empty"),
      productId: "prod-8",
    })
    expect(result.nodes).toEqual([])
    expect(result.claims).toEqual([])
    expect(result.edges).toEqual([])
    expect(result.extractor).toBe("graphql@1")
    expect(result.source_id).toBe("src-empty")
  })

  test("malformed SDL returns empty extraction with extraction_error claim", async () => {
    const result = await extractGraphql({
      bytes: sdl("type { broken sdl !!!"),
      source: fakeSource("src-bad"),
      productId: "prod-9",
    })
    expect(result.nodes).toEqual([])
    expect(result.edges).toEqual([])
    const errorClaim = result.claims.find(c => c.field === "extraction_error")
    expect(errorClaim).toBeDefined()
    expect(typeof errorClaim?.value).toBe("string")
    expect(result.source_id).toBe("src-bad")
  })

  test("emits returns claim with return type string", async () => {
    const src = `
      type Query {
        issue(id: ID!): Issue
        issues: [Issue!]!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-10",
    })
    const returnClaims = result.claims.filter(c => c.field === "returns")
    expect(returnClaims).toHaveLength(2)
    const returnVals = returnClaims.map(c => c.value as string).sort()
    expect(returnVals).toEqual(["Issue", "[Issue!]!"])
  })

  test("all operation nodes are parented to a surface node", async () => {
    const src = `
      type Query {
        users: [User!]!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-11",
    })
    const surface = result.nodes.find(n => n.kind === "surface")
    expect(surface).toBeDefined()
    const ops = result.nodes.filter(n => n.kind === "operation")
    for (const op of ops) {
      expect(op.parent_id).toBe(surface?.id)
    }
  })

  test("all operation claims have attested confidence", async () => {
    const src = `
      type Query {
        users: [User!]!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-12",
    })
    const opNodeIds = new Set(
      result.nodes.filter(n => n.kind === "operation").map(n => n.id),
    )
    for (const claim of result.claims) {
      if (opNodeIds.has(claim.node_id)) {
        expect(claim.confidence).toBe("attested")
      }
    }
  })

  test("field without arguments has no params claim", async () => {
    const src = `
      type Query {
        me: User!
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-13",
    })
    const params = result.claims.find(c => c.field === "params")
    expect(params).toBeUndefined()
  })

  test("emits a synthetic Bearer auth_scheme node anchored to product", async () => {
    const src = `
      type Query { ping: String }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-auth",
    })
    const auth = result.nodes.filter(n => n.kind === "auth_scheme")
    expect(auth).toHaveLength(1)
    expect(auth[0]?.parent_id).toBe("prod-auth")
    const typeClaim = result.claims.find(
      c => c.node_id === auth[0]?.id && c.field === "type",
    )
    expect(typeClaim?.value).toBe("bearer")
    expect(typeClaim?.confidence).toBe("inferred")
  })

  test("printArg includes argument description when present", async () => {
    const src = `
      type Query {
        issue(
          """The unique ID of the issue."""
          id: ID!
          teamId: String
        ): Issue
      }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-arg-desc",
    })
    const params = result.claims.find(c => c.field === "params")
    expect(params).toBeDefined()
    const val = params?.value as string[]
    // Arg with description should include it after an em-dash separator
    expect(val).toContain("id: ID! — The unique ID of the issue.")
    // Arg without description keeps the original format
    expect(val).toContain("teamId: String")
  })

  test("does not emit auth_scheme when SDL has no operations", async () => {
    const src = `
      type Foo { x: String }
    `
    const result = await extractGraphql({
      bytes: sdl(src),
      source: fakeSource(),
      productId: "prod-noop",
    })
    expect(result.nodes.filter(n => n.kind === "auth_scheme")).toHaveLength(0)
  })
})
