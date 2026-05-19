// tests/renderers/oas.test.ts
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderSyntheticOpenApi } from "../../src/renderers/oas.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-05-19T12:00:00.000Z";

async function ingestOpenapi(graph: GraphDb): Promise<void> {
  const bytes = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const config: SkillshipConfig = {
    product: { domain: "min.example", github_org: null },
    sources: [{ surface: "rest", url: "https://min.example/openapi.yaml", sha256: sha, content_type: "application/openapi+yaml", fetched_at: NOW }],
    coverage: "bronze",
  };
  await ingestConfig({ db: graph.db, config, productId: "p-min", loadBytes: async () => bytes, now: () => NOW });
}

describe("renderSyntheticOpenApi (OpenAPI-sourced)", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  test("emits a valid OpenAPI 3.1 document with paths and operations", async () => {
    await ingestOpenapi(graph);
    const out = renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) });
    const doc = JSON.parse(out);
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("min.example");
    expect(doc.paths["/projects"].get).toBeDefined();
    expect(doc.paths["/projects"].post).toBeDefined();
  });

  test("projects parameters with location and required", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const params = doc.paths["/projects"].get.parameters as Array<{ name: string; in: string; required: boolean }>;
    const limit = params.find(p => p.name === "limit");
    expect(limit?.in).toBe("query");
    const trace = params.find(p => p.name === "X-Trace-Id");
    expect(trace?.required).toBe(true);
  });

  test("is deterministic (byte-identical across two renders)", async () => {
    await ingestOpenapi(graph);
    const a = renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) });
    const b = renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) });
    expect(a).toBe(b);
  });

  test("path-item method keys are alphabetically sorted", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const methodKeys = Object.keys(doc.paths["/projects"]);
    expect(methodKeys).toEqual([...methodKeys].sort());
    expect(methodKeys.length).toBeGreaterThanOrEqual(2);
  });

  test("projects bearer auth into securitySchemes + operation security", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const schemes = doc.components.securitySchemes as Record<string, { type: string; scheme?: string }>;
    const bearer = Object.values(schemes).find(s => s.type === "http" && s.scheme === "bearer");
    expect(bearer).toBeDefined();
    expect(Array.isArray(doc.paths["/projects"].get.security)).toBe(true);
    const secKeys = Object.keys(schemes);
    const opSec = doc.paths["/projects"].get.security as Record<string, string[]>[];
    const opSecKeys = opSec.map(o => Object.keys(o)[0]);
    expect(opSecKeys.length).toBeGreaterThan(0);
    expect(opSecKeys.every(k => secKeys.includes(k!))).toBe(true);
  });

  test("derives a tag from the first REST path segment", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    expect(doc.paths["/projects"].get.tags).toEqual(["projects"]);
  });
});

describe("renderSyntheticOpenApi (GraphQL-sourced — no OpenAPI spec)", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-gql-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  test("produces operations from a GraphQL SDL graph (the differentiator gate)", async () => {
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/graphql/minimal.graphql"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    // "graphql" is not a SurfaceKind value; "rest" satisfies the type. The GraphQL extractor is
    // selected purely by content_type "application/graphql" (src/ingest/dispatch.ts).
    const config: SkillshipConfig = {
      product: { domain: "gql.example", github_org: null },
      sources: [{ surface: "rest", url: "https://gql.example/graphql", sha256: sha, content_type: "application/graphql", fetched_at: NOW }],
      coverage: "bronze",
    };
    await ingestConfig({ db: graph.db, config, productId: "p-gql", loadBytes: async () => bytes, now: () => NOW });
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-gql", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) }));
    const pathKeys = Object.keys(doc.paths);

    // Exact path key assertions (verified against real render in Step 0 — do not weaken to substring).
    expect(pathKeys).toContain("/graphql#projects");
    expect(pathKeys).toContain("/graphql#createProject");
    for (const k of pathKeys) expect(doc.paths[k].post).toBeDefined();

    // Argument→parameter projection: proves the GraphQL `limit` arg is projected as a query param.
    // This is the behaviour Task 7 will golden-freeze; previously nothing verified it.
    const projectsPost = doc.paths["/graphql#projects"].post;
    const params = (projectsPost.parameters ?? []) as Array<{ name: string; in: string; required: boolean }>;
    const limit = params.find(p => p.name === "limit");
    expect(limit).toBeDefined();
    expect(limit?.in).toBe("query");

    // operationId presence: Task 7 freezes these hash-stable ids (format "op_<hex>").
    expect(typeof projectsPost.operationId).toBe("string");
    expect(projectsPost.operationId.length).toBeGreaterThan(0);

    // KNOWN LIMITATION (out of scope for the substrate plan — tracked as a
    // follow-up): src/extractors/graphql.ts emits a default bearer auth_scheme
    // node but no auth_requires edges, so GraphQL-sourced operations project
    // with no security. Asserted explicitly so Task 7 freezes this as a known,
    // intentional state rather than an accidental one.
    expect(doc.components.securitySchemes).toEqual({});
    expect(projectsPost.security).toBeUndefined();
  });

  test("is deterministic for a GraphQL-sourced graph (byte-identical across two renders)", async () => {
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/graphql/minimal.graphql"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    // "graphql" is not a SurfaceKind value; "rest" satisfies the type. The GraphQL extractor is
    // selected purely by content_type "application/graphql" (src/ingest/dispatch.ts).
    const config: SkillshipConfig = {
      product: { domain: "gql.example", github_org: null },
      sources: [{ surface: "rest", url: "https://gql.example/graphql", sha256: sha, content_type: "application/graphql", fetched_at: NOW }],
      coverage: "bronze",
    };
    await ingestConfig({ db: graph.db, config, productId: "p-gql", loadBytes: async () => bytes, now: () => NOW });
    const a = renderSyntheticOpenApi({ db: graph.db, productId: "p-gql", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) });
    const b = renderSyntheticOpenApi({ db: graph.db, productId: "p-gql", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) });
    expect(a).toBe(b);
  });
});

describe("renderSyntheticOpenApi — apiKey non-header location", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-apikey-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  test("projects apiKey with location=query into securitySchemes and operation security", () => {
    const db = graph.db;
    const NOW_TS = "2026-05-19T12:00:00.000Z";
    const PRODUCT_ID = "p-apikey";
    const SURFACE_ID = "sfc_test_surface";
    const OP_ID = "op_test_keys";
    const AUTH_ID = "ath_test_apikey";
    // A fake source row is required because claims.source_id is NOT NULL REFERENCES sources(id).
    const SOURCE_ID = "src_fake_apikey";
    db.prepare(
      `INSERT INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(SOURCE_ID, "rest", "https://apikey.example/openapi.yaml", "application/openapi+yaml", NOW_TS, 0, ".skillship/sources/fake.yaml");

    // Insert surface node (kind='surface', parent_id=productId, id starts with 'sfc_' for REST)
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(SURFACE_ID, "surface", PRODUCT_ID, NOW_TS, NOW_TS);

    // Insert operation node (kind='operation', parent_id=surfaceId)
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(OP_ID, "operation", SURFACE_ID, NOW_TS, NOW_TS);

    // Insert auth_scheme node (kind='auth_scheme', parent_id=productId as the extractor does)
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(AUTH_ID, "auth_scheme", PRODUCT_ID, NOW_TS, NOW_TS);

    // Helper to insert a claim
    const insertClaim = (nodeId: string, field: string, value: unknown, claimId: string): void => {
      db.prepare(
        `INSERT INTO claims
           (id, node_id, field, value_json, source_id, extractor, extracted_at,
            span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(claimId, nodeId, field, JSON.stringify(value), SOURCE_ID, "openapi@3", NOW_TS, null, null, null, "attested", 0, null);
    };

    // Operation claims: method (UPPERCASE) and path_or_name
    insertClaim(OP_ID, "method", "GET", "cl_op_method");
    insertClaim(OP_ID, "path_or_name", "/keys", "cl_op_path");

    // Auth scheme claims: type="apiKey", location="query", param_name="api_key"
    insertClaim(AUTH_ID, "type", "apiKey", "cl_auth_type");
    insertClaim(AUTH_ID, "location", "query", "cl_auth_location");
    insertClaim(AUTH_ID, "param_name", "api_key", "cl_auth_param");

    // Edge: op --auth_requires--> auth_scheme
    db.prepare(
      `INSERT INTO edges (id, kind, from_node_id, to_node_id, source_id, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("edg_op_auth", "auth_requires", OP_ID, AUTH_ID, null, null, NOW_TS);

    const doc = JSON.parse(
      renderSyntheticOpenApi({ db, productId: PRODUCT_ID, productName: "apikey.example", overlay: CodegenOverlaySchema.parse({}) }),
    );

    // Exactly one securityScheme entry
    const schemes = doc.components.securitySchemes as Record<string, unknown>;
    const schemeEntries = Object.entries(schemes);
    expect(schemeEntries).toHaveLength(1);

    // The scheme must be { type: "apiKey", in: "query", name: "api_key" }
    const [schemeKey, schemeValue] = schemeEntries[0]!;
    expect(schemeValue).toEqual({ type: "apiKey", in: "query", name: "api_key" });

    // The operation's security array must reference the same scheme key
    const opSecurity = doc.paths["/keys"].get.security as Record<string, string[]>[];
    expect(Array.isArray(opSecurity)).toBe(true);
    expect(opSecurity).toHaveLength(1);
    expect(opSecurity[0]).toHaveProperty(schemeKey);
  });
});
