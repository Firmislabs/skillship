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

  test("schema_ref claim with full #/components/schemas/ prefix produces well-formed $ref and schemas key (regression: no double-prefix)", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const schema200 = doc.paths["/projects"].get.responses["200"].content["application/json"].schema as Record<string, string>;
    const ref = schema200["$ref"];
    // Must match a single #/components/schemas/ prefix followed by a bare name (no embedded #)
    expect(ref).toMatch(/^#\/components\/schemas\/[^#]+$/);
    // Extract the trailing segment after the prefix
    const refName = ref.replace("#/components/schemas/", "");
    // components.schemas must have that bare name as a key (not the full $ref string)
    expect(doc.components.schemas).toHaveProperty(refName);
    // The $ref must resolve: schemas[refName] must be defined
    expect((doc.components.schemas as Record<string, unknown>)[refName]).toBeDefined();
  });

  test("applies an O-SHAPE resources overlay (operationId rename + tag) and stays deterministic", async () => {
    await ingestOpenapi(graph);
    const base = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const realOpId = base.paths["/projects"].get.operationId as string;
    const overlay = CodegenOverlaySchema.parse({ resources: { [realOpId]: { namespace: "projects", rename: "listProjects" } } });
    const a = renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay });
    const b = renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay });
    expect(a).toBe(b);
    const doc = JSON.parse(a);
    expect(doc.paths["/projects"].get.operationId).toBe("listProjects");
    expect(doc.paths["/projects"].get.tags).toEqual(["projects"]);
    expect(doc["x-skillship-codegen"]).toBeDefined();
  });
});

describe("renderSyntheticOpenApi — buildTags (Gap 6 namespace tags)", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-tags-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  function seedOp(opSuffix: string, path: string, declaredTags?: string[]): void {
    const db = graph.db;
    const NOW_TS = "2026-05-19T12:00:00.000Z";
    const PRODUCT_ID = "p-tags";
    const SURFACE_ID = "sfc_tags_surface";
    const OP_ID = `op_tags_${opSuffix}`;
    const SOURCE_ID = "src_fake_tags";
    db.prepare(
      `INSERT OR IGNORE INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(SOURCE_ID, "rest", "https://tags.example/openapi.yaml", "application/openapi+yaml", NOW_TS, 0, ".skillship/sources/fake.yaml");
    db.prepare(
      `INSERT OR IGNORE INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(SURFACE_ID, "surface", PRODUCT_ID, NOW_TS, NOW_TS);
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(OP_ID, "operation", SURFACE_ID, NOW_TS, NOW_TS);
    const insertClaim = (field: string, value: unknown, claimId: string): void => {
      db.prepare(
        `INSERT INTO claims
           (id, node_id, field, value_json, source_id, extractor, extracted_at,
            span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(claimId, OP_ID, field, JSON.stringify(value), SOURCE_ID, "openapi@3", NOW_TS, null, null, null, "attested", 0, null);
    };
    insertClaim("method", "GET", `cl_${opSuffix}_method`);
    insertClaim("path_or_name", path, `cl_${opSuffix}_path`);
    if (declaredTags !== undefined) insertClaim("tags", declaredTags, `cl_${opSuffix}_tags`);
  }

  function tagsFor(path: string): string[] | undefined {
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: "p-tags", productName: "tags.example", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const renderPath = path.startsWith("/") ? path : `/${path}`;
    return doc.paths[renderPath]?.get?.tags as string[] | undefined;
  }

  test("declared tag wins and is lowercased even with a version-prefixed path", () => {
    seedOp("declared", "/v1/files/{id}", ["Files"]);
    expect(tagsFor("/v1/files/{id}")).toEqual(["files"]);
  });

  test("fallback skips a leading version segment (/v1/files/{id} -> files)", () => {
    seedOp("ver", "/v1/files/{id}");
    expect(tagsFor("/v1/files/{id}")).toEqual(["files"]);
  });

  test("fallback skips leading api + numeric segments (/api/0/projects -> projects)", () => {
    seedOp("api", "/api/0/projects");
    expect(tagsFor("/api/0/projects")).toEqual(["projects"]);
  });

  test("clean path is unchanged (/projects -> projects)", () => {
    seedOp("clean", "/projects");
    expect(tagsFor("/projects")).toEqual(["projects"]);
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

    // operationId format gate: Task 7 freezes these hash-stable ids (format "op_<hex>").
    expect(projectsPost.operationId).toMatch(/^op_[0-9a-f]+$/);

    // Gap 1 closure: GraphQL ops now project the default bearer scheme into
    // components.securitySchemes + per-op security (commit 62bf044).
    // The scheme key is hash-stable: `bearer_${stableId("ath", [productId, "graphql-default"])}`,
    // i.e. matches /^bearer_ath_[0-9a-f]+$/. We locate it by value shape rather
    // than literal key so the assertion survives hash changes in the id algorithm.
    const gqlSchemes = doc.components.securitySchemes as Record<string, { type: string; scheme?: string }>;
    const gqlBearer = Object.values(gqlSchemes).find(s => s.type === "http" && s.scheme === "bearer");
    expect(gqlBearer).toBeDefined();
    const gqlSchemeKeys = Object.keys(gqlSchemes);
    expect(gqlSchemeKeys.length).toBe(1);
    expect(gqlSchemeKeys[0]).toMatch(/^bearer_ath_[0-9a-f]+$/);
    const gqlSec = projectsPost.security as Record<string, string[]>[];
    expect(Array.isArray(gqlSec)).toBe(true);
    expect(gqlSec.length).toBe(1);
    const gqlSecKey = Object.keys(gqlSec[0]!)[0];
    expect(gqlSecKey).toBe(gqlSchemeKeys[0]);
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
    await ingestConfig({ db: graph.db, config, productId: "p-gql-det", loadBytes: async () => bytes, now: () => NOW });
    const a = renderSyntheticOpenApi({ db: graph.db, productId: "p-gql-det", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) });
    const b = renderSyntheticOpenApi({ db: graph.db, productId: "p-gql-det", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) });
    expect(a).toBe(b);
  });
});

describe("renderSyntheticOpenApi — requestBody schema_ref projects as $ref (regression: Gap 2 renderer fix)", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-bodyref-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  test("body parameter with schema_ref claim produces $ref in requestBody schema and registers component schema", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const post = doc.paths["/projects"].post;
    const schema = post.requestBody.content["application/json"].schema as Record<string, unknown>;
    expect(schema["$ref"]).toBe("#/components/schemas/ProjectInput");
    expect(schema).not.toHaveProperty("type");
    expect(doc.components.schemas).toHaveProperty("ProjectInput");
    expect((doc.components.schemas as Record<string, unknown>)["ProjectInput"]).toEqual({ type: "object" });
  });

  test("components.schemas has ProjectInput before ProjectList (alphabetical order)", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const schemaKeys = Object.keys(doc.components.schemas as Record<string, unknown>);
    expect(schemaKeys).toContain("ProjectInput");
    expect(schemaKeys).toContain("ProjectList");
    expect(schemaKeys.indexOf("ProjectInput")).toBeLessThan(schemaKeys.indexOf("ProjectList"));
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

describe("renderSyntheticOpenApi — oauth2 flows projection (T4)", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-oauth2-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  function seedOauth2(withFlows: boolean): void {
    const db = graph.db;
    const NOW_TS = "2026-06-10T00:00:00.000Z";
    const PRODUCT_ID = "p-oauth2";
    const SURFACE_ID = "sfc_oauth2_surface";
    const OP_ID = "op_oauth2_get";
    const AUTH_ID = "ath_oauth2_scheme";
    const SOURCE_ID = "src_fake_oauth2";
    db.prepare(
      `INSERT INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(SOURCE_ID, "rest", "https://api.x.test/openapi.json", "application/json", NOW_TS, 0, ".skillship/sources/fake.json");
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(SURFACE_ID, "surface", PRODUCT_ID, NOW_TS, NOW_TS);
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(OP_ID, "operation", SURFACE_ID, NOW_TS, NOW_TS);
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(AUTH_ID, "auth_scheme", PRODUCT_ID, NOW_TS, NOW_TS);

    const insertClaim = (nodeId: string, field: string, value: unknown, claimId: string): void => {
      db.prepare(
        `INSERT INTO claims
           (id, node_id, field, value_json, source_id, extractor, extracted_at,
            span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(claimId, nodeId, field, JSON.stringify(value), SOURCE_ID, "openapi@3", NOW_TS, null, null, null, "attested", 0, null);
    };

    insertClaim(OP_ID, "method", "GET", "cl_op2_method");
    insertClaim(OP_ID, "path_or_name", "/things", "cl_op2_path");
    insertClaim(AUTH_ID, "type", "oauth2", "cl_auth2_type");
    if (withFlows) {
      insertClaim(AUTH_ID, "flows", { clientCredentials: { tokenUrl: "https://api.x.test/oauth/token", scopes: {} } }, "cl_auth2_flows");
    }

    db.prepare(
      `INSERT INTO edges (id, kind, from_node_id, to_node_id, source_id, rationale, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("edg_op2_auth", "auth_requires", OP_ID, AUTH_ID, null, null, NOW_TS);
  }

  test("oauth2 scheme with flows claim projects flows verbatim into securitySchemes", () => {
    seedOauth2(true);
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: "p-oauth2", productName: "api.x.test", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const schemes = doc.components.securitySchemes as Record<string, unknown>;
    const schemeEntries = Object.entries(schemes);
    expect(schemeEntries).toHaveLength(1);
    const schemeValue = schemeEntries[0]![1] as Record<string, unknown>;
    expect(schemeValue["type"]).toBe("oauth2");
    const flows = schemeValue["flows"] as Record<string, unknown>;
    expect(flows).toBeDefined();
    expect(flows).not.toEqual({});
    const cc = flows["clientCredentials"] as Record<string, unknown>;
    expect(cc).toBeDefined();
    expect(cc["tokenUrl"]).toBe("https://api.x.test/oauth/token");
  });

  test("oauth2 scheme without flows claim falls back to flows: {} (unchanged behaviour)", () => {
    seedOauth2(false);
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: "p-oauth2", productName: "api.x.test", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const schemes = doc.components.securitySchemes as Record<string, unknown>;
    const schemeEntries = Object.entries(schemes);
    expect(schemeEntries).toHaveLength(1);
    const schemeValue = schemeEntries[0]![1] as Record<string, unknown>;
    expect(schemeValue["type"]).toBe("oauth2");
    expect(schemeValue["flows"]).toEqual({});
  });
});

// ---- Annotation projection tests (Task 1) ----

describe("renderSyntheticOpenApi — x-skillship-annotations projection", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-ann-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  const NOW_TS = "2026-06-10T00:00:00.000Z";
  const PRODUCT_ID = "p-ann";
  const SURFACE_ID = "sfc_ann_surface";
  const SOURCE_ID = "src_fake_ann";

  function seedOp(opId: string, path: string, annotationClaims: Record<string, boolean>): void {
    const db = graph.db;
    db.prepare(
      `INSERT OR IGNORE INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(SOURCE_ID, "rest", "https://ann.example/openapi.yaml", "application/openapi+yaml", NOW_TS, 0, ".skillship/sources/fake.yaml");
    db.prepare(
      `INSERT OR IGNORE INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(SURFACE_ID, "surface", PRODUCT_ID, NOW_TS, NOW_TS);
    db.prepare(
      `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(opId, "operation", SURFACE_ID, NOW_TS, NOW_TS);

    const insertClaim = (field: string, value: unknown, claimId: string): void => {
      db.prepare(
        `INSERT INTO claims
           (id, node_id, field, value_json, source_id, extractor, extracted_at,
            span_start, span_end, span_path, confidence, chosen, rejection_rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(claimId, opId, field, JSON.stringify(value), SOURCE_ID, "openapi@3", NOW_TS, null, null, null, "attested", 0, null);
    };

    insertClaim("method", "POST", `cl_${opId}_method`);
    insertClaim("path_or_name", path, `cl_${opId}_path`);
    for (const [field, val] of Object.entries(annotationClaims)) {
      insertClaim(field, val, `cl_${opId}_${field}`);
    }
  }

  test("is_destructive:true claim → operation carries x-skillship-annotations.destructive = true", () => {
    seedOp("op_ann_destr", "/items", { is_destructive: true });
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: PRODUCT_ID, productName: "ann.example", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const ann = doc.paths["/items"].post["x-skillship-annotations"] as Record<string, unknown>;
    expect(ann).toBeDefined();
    expect(ann["destructive"]).toBe(true);
  });

  test("is_read_only:false claim → operation carries x-skillship-annotations.readOnly = false", () => {
    seedOp("op_ann_ro", "/items", { is_read_only: false });
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: PRODUCT_ID, productName: "ann.example", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const ann = doc.paths["/items"].post["x-skillship-annotations"] as Record<string, unknown>;
    expect(ann).toBeDefined();
    expect(ann["readOnly"]).toBe(false);
  });

  test("is_idempotent:true claim → operation carries x-skillship-annotations.idempotent = true", () => {
    seedOp("op_ann_idemp", "/items", { is_idempotent: true });
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: PRODUCT_ID, productName: "ann.example", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const ann = doc.paths["/items"].post["x-skillship-annotations"] as Record<string, unknown>;
    expect(ann).toBeDefined();
    expect(ann["idempotent"]).toBe(true);
  });

  test("op with no annotation claims: no x-skillship-annotations key in rendered output", () => {
    seedOp("op_ann_none", "/items", {});
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: PRODUCT_ID, productName: "ann.example", overlay: CodegenOverlaySchema.parse({}) }),
    );
    expect(doc.paths["/items"].post["x-skillship-annotations"]).toBeUndefined();
  });

  test("multiple annotation claims render as combined extension object", () => {
    seedOp("op_ann_multi", "/items", { is_destructive: true, is_idempotent: false });
    const doc = JSON.parse(
      renderSyntheticOpenApi({ db: graph.db, productId: PRODUCT_ID, productName: "ann.example", overlay: CodegenOverlaySchema.parse({}) }),
    );
    const ann = doc.paths["/items"].post["x-skillship-annotations"] as Record<string, unknown>;
    expect(ann).toBeDefined();
    expect(ann["destructive"]).toBe(true);
    expect(ann["idempotent"]).toBe(false);
  });
});
