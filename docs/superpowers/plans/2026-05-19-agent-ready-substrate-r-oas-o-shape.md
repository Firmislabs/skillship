# Agent-Ready Substrate (R-OAS + O-SHAPE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two pure, deterministic, in-repo skillship components — `R-OAS` (graph → synthetic OpenAPI 3.1) and `O-SHAPE` (a codegen-shaping overlay) — and freeze them behind committed golden fixtures so the later R-SDK and R-MCP renderers can be built independently against a stable artifact.

**Architecture:** Both components are additive pure functions over skillship's existing SQLite graph (`nodes`/`claims`/`edges`), following the existing renderer pattern (`src/renderers/*.ts`, `({ db, productId, ... }) => string`). R-OAS projects the graph to an OpenAPI 3.1 JSON document; O-SHAPE loads/validates `.skillship/overlays/codegen.yaml` and stamps shaping directives onto that document as `x-skillship-codegen` vendor extensions so a single artifact feeds both downstream renderers. Wired into `src/cli/build.ts:writeAll` as a new `openapi.json` artifact. No new ingest, no new config system, no changes to existing extractors/graph.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), `better-sqlite3`, `zod`, `yaml`, `vitest`. Spec: `docs/superpowers/specs/2026-05-19-agent-ready-renderers-design.md` (§4.1 R-OAS, §4.2 O-SHAPE).

---

## Scope

**In this plan:** `src/overlays/codegen.ts`, `src/renderers/oas.ts`, wiring in `src/cli/build.ts`, a GraphQL SDL test fixture, and golden tests for an OpenAPI-sourced and a GraphQL-sourced graph.

**Not in this plan (later plans, depend on this one's frozen golden):** Plan 2 = R-SDK (synthetic OAS → Hey API → TS SDK + 7 plugins). Plan 3 = R-MCP (synthetic OAS → runnable MCP server). Do not start Plans 2/3 until the golden fixtures committed by this plan exist and CI is green.

## File Structure

- `src/overlays/codegen.ts` — **Create.** Zod schema `CodegenOverlay` + `loadCodegenOverlay(inDir)` (reads `.skillship/overlays/codegen.yaml`, returns validated overlay or defaults) + `applyOverlayToDoc(doc, overlay)` (mutates the OpenAPI object: operationId rename, tag override, stamps `x-skillship-codegen`). One responsibility: the codegen overlay. Target < 200 lines.
- `src/renderers/oas.ts` — **Create.** `renderSyntheticOpenApi({ db, productId, productName, overlay })` → deterministic JSON string. Pure projection helpers (`listSurfaces`, `listOperations`, `buildPathItem`, `buildSecuritySchemes`, `collectTags`). One responsibility: graph → OpenAPI 3.1. Target < 300 lines; each helper < 50 lines.
- `src/cli/build.ts` — **Modify** `writeAll` (around `src/cli/build.ts:93-99`) to add `openapi.json` + a `renderOas` helper mirroring `renderMcp`.
- `tests/fixtures/graphql/minimal.graphql` — **Create.** Small GraphQL SDL fixture (mandatory per spec §6: the GraphQL-sourced conformance gate that proves "works without an OpenAPI spec").
- `tests/overlays/codegen.test.ts` — **Create.** Overlay schema + apply tests.
- `tests/renderers/oas.test.ts` — **Create.** Golden tests: OpenAPI-sourced (`tests/fixtures/openapi3/minimal.yaml`) and GraphQL-sourced (`tests/fixtures/graphql/minimal.graphql`).
- `tests/fixtures/golden/oas-minimal.json`, `tests/fixtures/golden/oas-graphql-minimal.json` — **Create (committed goldens).** The frozen substrate artifact Plans 2/3 build against.

## Conventions (read before starting)

- Renderers are pure: read graph via `readBestClaim(db, nodeId, field)` (string fields) or raw `db.prepare("SELECT value_json FROM claims WHERE node_id=? AND field=? ORDER BY id LIMIT 1").get(...)` (non-string). Pattern reference: `src/renderers/opReference.ts`.
- Graph shape (VERIFIED against `src/extractors/*` + `src/graph/types.ts` on 2026-05-19 — trust this, not inference):
  - `nodes(id, kind, parent_id)`; surfaces `kind='surface'` `parent_id=<productId>`; operations `kind='operation'` `parent_id=<surfaceId>`; parameters/response_shape `parent_id=<opId>`.
  - **Surface discrimination has NO `surface` claim.** `stableId(prefix,parts)` returns `` `${prefix}_${hash}` ``. REST (openapi3/swagger2) surface id = `sfc_…`; GraphQL surface id = `srf_…`. Detect GraphQL by `surfaceId.startsWith("srf_")`, with a secondary check on the op `method` claim.
  - Operation `method` claim is **UPPERCASE**: REST → HTTP verb (`GET`,`POST`,…); GraphQL → root type (`QUERY`,`MUTATION`,`SUBSCRIPTION`). `path_or_name`: REST → URL path; GraphQL → field name (e.g. `projects`).
  - **Parameters differ by source.** REST: `kind='parameter'` child nodes with claims `name`,`location`,`required`,`type`,`description`,`enum_values`. GraphQL: NO parameter child nodes — args are a single `params` claim on the op = JSON string array of printed args (e.g. `["limit: Int"]`). `buildParams` MUST handle both.
  - `response_shape` child nodes (REST only) have claims `status_code`,`content_type`,`schema_ref`.
  - `version` claim lives on the **surface** node (`field='version'`), NOT the product node.
  - Edges actually emitted: `has_operation`, `has_parameter`, `returns`, `auth_requires`. `acts_on` and the `resource` node kind are in the `EdgeKind`/`NodeKind` unions but **NO extractor emits them** — do not read them. auth_scheme claims: `type`, `param_name`.
  - **Tags / resource grouping (spec deviation — flagged to user):** spec §4.1 says tags come "from `resource` via `acts_on`". Those do not exist in the graph. The substrate instead derives a tag from the REST path's first segment (or the GraphQL root type), and O-SHAPE's `resources` overlay is the authoritative override. This is the pragmatic equivalent of §4.1's intent; it requires a one-line spec amendment (see plan footer).
- Determinism is a hard requirement (spec §2.5): iterate sorted by `id`, build objects by inserting keys in sorted order, `JSON.stringify(doc, null, 2)`.
- Test harness pattern: `openGraph(path)` → `graph.db`; populate via `ingestConfig` from a fixture (see `tests/renderers/skill.test.ts:14-42`).
- TDD strictly: write failing test → run (confirm RED) → minimal impl → run (GREEN) → commit. Each step 2-5 min. Commit after every GREEN.
- After each task run preflight `npm run typecheck` and `npm test` — the existing suite (359 tests) MUST stay green (spec R4). Capture exit codes: `npm test; echo "EXIT=$?"`.

---

### Task 1: O-SHAPE overlay schema + loader

**Files:**
- Create: `src/overlays/codegen.ts`
- Test: `tests/overlays/codegen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/overlays/codegen.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadCodegenOverlay, type CodegenOverlay } from "../../src/overlays/codegen.js";

describe("loadCodegenOverlay", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sk-ovl-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns defaults when no overlay file exists", () => {
    const ovl = loadCodegenOverlay(dir);
    expect(ovl.resources).toEqual({});
    expect(ovl.pagination).toBeUndefined();
    expect(ovl.streaming).toEqual([]);
  });

  test("parses a valid overlay file", () => {
    mkdirSync(join(dir, ".skillship", "overlays"), { recursive: true });
    writeFileSync(
      join(dir, ".skillship", "overlays", "codegen.yaml"),
      [
        "resources:",
        "  op_a: { namespace: users, rename: list }",
        "pagination:",
        "  style: cursor",
        "  fields: { cursor: next_cursor, items: data, hasMore: has_more }",
        "retries: { maxRetries: 3, idempotencyHeader: Idempotency-Key }",
        "streaming: [op_b]",
      ].join("\n"),
      "utf8",
    );
    const ovl: CodegenOverlay = loadCodegenOverlay(dir);
    expect(ovl.resources.op_a).toEqual({ namespace: "users", rename: "list" });
    expect(ovl.pagination?.style).toBe("cursor");
    expect(ovl.retries?.maxRetries).toBe(3);
    expect(ovl.streaming).toEqual(["op_b"]);
  });

  test("throws a typed path error on invalid overlay", () => {
    mkdirSync(join(dir, ".skillship", "overlays"), { recursive: true });
    writeFileSync(
      join(dir, ".skillship", "overlays", "codegen.yaml"),
      "pagination: { style: not-a-style }",
      "utf8",
    );
    expect(() => loadCodegenOverlay(dir)).toThrow(/pagination\.style/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/overlays/codegen.test.ts`
Expected: FAIL — `Cannot find module '../../src/overlays/codegen.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/overlays/codegen.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ResourceRule = z.object({
  namespace: z.string().min(1),
  rename: z.string().min(1).optional(),
});

const Pagination = z.object({
  style: z.enum(["cursor", "offset", "page"]),
  fields: z.record(z.string()).default({}),
  perOperation: z.record(z.enum(["cursor", "offset", "page"])).default({}),
});

const Retries = z.object({
  maxRetries: z.number().int().min(0).default(2),
  backoff: z.enum(["exponential-jitter"]).default("exponential-jitter"),
  honorRetryAfter: z.boolean().default(true),
  idempotencyHeader: z.string().default("Idempotency-Key"),
  retryableStatus: z.array(z.number().int()).default([408, 409, 429, 500, 502, 503, 504]),
});

const Auth = z.object({
  mode: z.enum(["bearer", "apiKey", "oauth2-client-credentials"]),
  in: z.enum(["header", "query"]).default("header"),
  name: z.string().optional(),
});

const Webhooks = z.object({
  scheme: z.enum(["hmac-sha256"]).default("hmac-sha256"),
  signatureHeader: z.string().default("Webhook-Signature"),
});

export const CodegenOverlaySchema = z.object({
  resources: z.record(ResourceRule).default({}),
  pagination: Pagination.optional(),
  retries: Retries.optional(),
  auth: Auth.optional(),
  streaming: z.array(z.string()).default([]),
  webhooks: Webhooks.optional(),
});

export type CodegenOverlay = z.infer<typeof CodegenOverlaySchema>;

export function loadCodegenOverlay(inDir: string): CodegenOverlay {
  const path = join(inDir, ".skillship", "overlays", "codegen.yaml");
  if (!existsSync(path)) return CodegenOverlaySchema.parse({});
  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  const result = CodegenOverlaySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new Error(
      `codegen overlay invalid at ${first.path.join(".")}: ${first.message}`,
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/overlays/codegen.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Preflight + commit**

```bash
npm run typecheck && npx vitest run tests/overlays/codegen.test.ts; echo "EXIT=$?"
git add src/overlays/codegen.ts tests/overlays/codegen.test.ts
git commit -m "feat(overlay): O-SHAPE codegen overlay schema + loader"
```

---

### Task 2: R-OAS core projection (paths, params, responses)

**Files:**
- Create: `src/renderers/oas.ts`
- Test: `tests/renderers/oas.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderers/oas.test.ts`
Expected: FAIL — `Cannot find module '../../src/renderers/oas.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/renderers/oas.ts
import type { Database as Sqlite3Database } from "better-sqlite3";
import { readBestClaim } from "./claims.js";
import type { CodegenOverlay } from "../overlays/codegen.js";

export interface RenderOasInput {
  readonly db: Sqlite3Database;
  readonly productId: string;
  readonly productName: string;
  readonly overlay: CodegenOverlay;
}

interface OpRow { readonly id: string; readonly surfaceId: string; readonly isGraphql: boolean; }

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const GQL_METHODS = ["QUERY", "MUTATION", "SUBSCRIPTION"];

export function renderSyntheticOpenApi(input: RenderOasInput): string {
  const ops = listOperations(input.db, input.productId);
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const unmapped: { op: string; reason: string }[] = [];

  for (const op of ops) {
    const rawMethod = readBestClaim(input.db, op.id, "method") ?? ""; // UPPERCASE in graph
    const name = readBestClaim(input.db, op.id, "path_or_name") ?? op.id;
    const httpMethod = rawMethod.toLowerCase();
    if (op.isGraphql || GQL_METHODS.includes(rawMethod.toUpperCase())) {
      // GraphQL: one POST tool per field; field name carried in the path fragment
      const path = `/graphql#${name}`;
      (paths[path] ??= {}).post = buildOperation(input.db, op.id, schemas, op.isGraphql);
      continue;
    }
    if (!HTTP_METHODS.includes(httpMethod)) {
      unmapped.push({ op: op.id, reason: `unmappable method '${rawMethod}'` });
      continue;
    }
    const path = name.startsWith("/") ? name : `/${name}`;
    (paths[path] ??= {})[httpMethod] = buildOperation(input.db, op.id, schemas, false);
  }

  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: { title: input.productName, version: surfaceVersion(input.db, input.productId) },
    paths: sortKeys(paths),
    components: { schemas: sortKeys(schemas) },
  };
  if (unmapped.length > 0) doc["x-skillship-unmapped"] = unmapped.sort((a, b) => a.op.localeCompare(b.op));
  return JSON.stringify(doc, null, 2);
}

function listOperations(db: Sqlite3Database, productId: string): OpRow[] {
  const rows = db.prepare(
    `SELECT n.id AS id, s.id AS surfaceId FROM nodes n
       JOIN nodes s ON s.id = n.parent_id
      WHERE n.kind = 'operation' AND s.parent_id = ? ORDER BY n.id`,
  ).all(productId) as { id: string; surfaceId: string }[];
  return rows.map(r => ({
    id: r.id,
    surfaceId: r.surfaceId,
    isGraphql: r.surfaceId.startsWith("srf_"), // sfc_ = REST, srf_ = GraphQL
  }));
}

// version claim is written on the SURFACE node, not the product node
function surfaceVersion(db: Sqlite3Database, productId: string): string {
  const rows = db.prepare(
    `SELECT id FROM nodes WHERE kind = 'surface' AND parent_id = ? ORDER BY id`,
  ).all(productId) as { id: string }[];
  for (const r of rows) {
    const v = readBestClaim(db, r.id, "version");
    if (v !== undefined) return v;
  }
  return "0.0.0";
}

function buildOperation(db: Sqlite3Database, opId: string, schemas: Record<string, unknown>, isGraphql: boolean): Record<string, unknown> {
  const op: Record<string, unknown> = { operationId: opId };
  const summary = readBestClaim(db, opId, "summary");
  if (summary !== undefined) op.summary = summary;
  const description = readBestClaim(db, opId, "description");
  if (description !== undefined) op.description = description;
  const { parameters, requestBody } = buildParams(db, opId, isGraphql);
  if (parameters.length > 0) op.parameters = parameters;
  if (requestBody !== undefined) op.requestBody = requestBody;
  op.responses = buildResponses(db, opId, schemas);
  return op;
}

function buildParams(db: Sqlite3Database, opId: string, isGraphql: boolean): {
  parameters: Record<string, unknown>[];
  requestBody: Record<string, unknown> | undefined;
} {
  if (isGraphql) {
    // GraphQL: args are a single `params` string-array claim on the op
    // (e.g. ["limit: Int"]). Project each as a best-effort query parameter.
    const raw = readJson(db, opId, "params");
    const args = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
    const parameters = args.map((a) => {
      const pname = (a.split(":")[0] ?? a).trim();
      return { name: pname, in: "query", required: false, schema: { type: "string" } };
    });
    return { parameters, requestBody: undefined };
  }
  const rows = db.prepare(
    `SELECT id FROM nodes WHERE kind = 'parameter' AND parent_id = ? ORDER BY id`,
  ).all(opId) as { id: string }[];
  const parameters: Record<string, unknown>[] = [];
  let requestBody: Record<string, unknown> | undefined;
  for (const r of rows) {
    const location = readBestClaim(db, r.id, "location") ?? "query";
    const pname = readBestClaim(db, r.id, "name") ?? "";
    const required = readBool(db, r.id, "required");
    const type = readBestClaim(db, r.id, "type") ?? "string";
    if (location === "body") {
      requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } };
      continue;
    }
    parameters.push({ name: pname, in: location, required, schema: { type: mapType(type) } });
  }
  return { parameters, requestBody };
}

function buildResponses(db: Sqlite3Database, opId: string, schemas: Record<string, unknown>): Record<string, unknown> {
  const rows = db.prepare(
    `SELECT id FROM nodes WHERE kind = 'response_shape' AND parent_id = ? ORDER BY id`,
  ).all(opId) as { id: string }[];
  const responses: Record<string, unknown> = {};
  for (const r of rows) {
    const status = String(readJson(db, r.id, "status_code") ?? "default");
    const ct = readBestClaim(db, r.id, "content_type") ?? "application/json";
    const ref = readBestClaim(db, r.id, "schema_ref");
    if (ref !== undefined) schemas[ref] = { type: "object" };
    responses[status] = {
      description: status,
      content: { [ct]: { schema: ref !== undefined ? { $ref: `#/components/schemas/${ref}` } : { type: "object" } } },
    };
  }
  if (Object.keys(responses).length === 0) responses["200"] = { description: "OK" };
  return sortKeys(responses);
}

function readBool(db: Sqlite3Database, nodeId: string, field: string): boolean {
  return readJson(db, nodeId, field) === true;
}

function readJson(db: Sqlite3Database, nodeId: string, field: string): unknown {
  const row = db.prepare(
    `SELECT value_json FROM claims WHERE node_id = ? AND field = ? ORDER BY id LIMIT 1`,
  ).get(nodeId, field) as { value_json: string } | undefined;
  if (row === undefined) return undefined;
  try { return JSON.parse(row.value_json); } catch { return undefined; }
}

function mapType(t: string): string {
  const k = t.toLowerCase();
  if (["integer", "number", "boolean", "array", "object", "string"].includes(k)) return k;
  return "string";
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]!;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/renderers/oas.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Preflight + commit**

```bash
npm run typecheck && npx vitest run tests/renderers/oas.test.ts; echo "EXIT=$?"
git add src/renderers/oas.ts tests/renderers/oas.test.ts
git commit -m "feat(oas): R-OAS core projection — paths, params, responses, deterministic"
```

---

### Task 3: R-OAS security schemes + derived tags

> **Spec deviation (carry into Task review):** spec §4.1 specifies tags "from `resource` via `acts_on`". Verified: no extractor emits `acts_on` edges or `resource` nodes, so that path yields nothing. The substrate derives a tag from the REST path's first real segment, or `query`/`mutation`/`subscription` for GraphQL. O-SHAPE's `resources` overlay is the authoritative override (Task 5). This needs the one-line spec amendment in the plan footer.

**Files:**
- Modify: `src/renderers/oas.ts`
- Test: `tests/renderers/oas.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

```ts
  test("projects bearer auth into securitySchemes + operation security", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    const schemes = doc.components.securitySchemes as Record<string, { type: string; scheme?: string }>;
    const bearer = Object.values(schemes).find(s => s.type === "http" && s.scheme === "bearer");
    expect(bearer).toBeDefined();
    expect(Array.isArray(doc.paths["/projects"].get.security)).toBe(true);
  });

  test("derives a tag from the first REST path segment", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    expect(doc.paths["/projects"].get.tags).toEqual(["projects"]);
  });
```

- [ ] **Step 2: Run — confirm RED**

Run: `npx vitest run tests/renderers/oas.test.ts -t "securitySchemes"`
Expected: FAIL — `securitySchemes` undefined.

- [ ] **Step 3: Implement — add to `src/renderers/oas.ts`**

Change `buildOperation`'s signature to `(db, opId, schemas, isGraphql, securitySchemes)` and thread `securitySchemes` from `renderSyntheticOpenApi`: declare `const securitySchemes: Record<string, unknown> = {};` next to `schemas`, pass it into BOTH `buildOperation(...)` call sites (the GraphQL branch and the REST branch), and change the doc's `components` to `{ schemas: sortKeys(schemas), securitySchemes: sortKeys(securitySchemes) }`. In `buildOperation`, after `op.responses = buildResponses(...)`:

```ts
  const sec = buildSecurity(db, opId, securitySchemes);
  if (sec.length > 0) op.security = sec;
  const tags = buildTags(db, opId, isGraphql);
  if (tags.length > 0) op.tags = tags;
```

Add (note: `buildTags` reads op claims — `path_or_name`/`method` — NOT `acts_on`/`resource`, which no extractor emits):

> Corrected 2026-05-19 (code-quality review): full auth-type coverage; apiKey reads the location claim; no dead 'http' arm.

```ts
function securitySchemeFor(db: Sqlite3Database, authId: string, type: string): Record<string, unknown> {
  if (type === "bearer") return { type: "http", scheme: "bearer" };
  if (type === "basic") return { type: "http", scheme: "basic" };
  if (type === "apikey") {
    const location = readBestClaim(db, authId, "location") ?? "header";
    const name = readBestClaim(db, authId, "param_name") ?? "Authorization";
    return { type: "apiKey", in: location, name };
  }
  if (type === "oauth2") return { type: "oauth2", flows: {} };
  if (type === "mutualtls") return { type: "mutualTLS" };
  // "custom" and any future unknown values: placeholder the overlay can correct
  return { type: "http", scheme: "bearer" };
}

function buildSecurity(db: Sqlite3Database, opId: string, sink: Record<string, unknown>): Record<string, string[]>[] {
  const rows = db.prepare(
    `SELECT DISTINCT to_node_id AS authId FROM edges WHERE from_node_id = ? AND kind = 'auth_requires'`,
  ).all(opId) as { authId: string }[];
  const out: Record<string, string[]>[] = [];
  for (const r of rows.sort((a, b) => a.authId.localeCompare(b.authId))) {
    const type = (readBestClaim(db, r.authId, "type") ?? "bearer").toLowerCase();
    const key = `${type}_${r.authId}`;
    sink[key] = securitySchemeFor(db, r.authId, type);
    out.push({ [key]: [] });
  }
  return out;
}

function buildTags(db: Sqlite3Database, opId: string, isGraphql: boolean): string[] {
  if (isGraphql) {
    const m = (readBestClaim(db, opId, "method") ?? "QUERY").toLowerCase();
    return [m]; // query | mutation | subscription
  }
  const path = readBestClaim(db, opId, "path_or_name") ?? "";
  const seg = path
    .split("/")
    .map(s => s.trim())
    .find(s => s.length > 0 && !s.startsWith("{"));
  return seg !== undefined ? [seg] : [];
}
```

- [ ] **Step 4: Run — confirm GREEN**

Run: `npx vitest run tests/renderers/oas.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Preflight + commit**

```bash
npm run typecheck && npx vitest run tests/renderers/oas.test.ts; echo "EXIT=$?"
git add src/renderers/oas.ts tests/renderers/oas.test.ts
git commit -m "feat(oas): securitySchemes from auth_requires + tags derived from path/type"
```

---

### Task 4: GraphQL-sourced fixture + conformance gate (mandatory per spec §6)

**Files:**
- Create: `tests/fixtures/graphql/minimal.graphql`
- Test: `tests/renderers/oas.test.ts` (add GraphQL describe block)

- [ ] **Step 1: Confirm the GraphQL `surface` config value + content_type the dispatcher routes on**

Run: `grep -rn "graphql\|content_type\|application/graphql\|sdl\|surface:" src/ingest/pipeline.ts src/ingest/dispatch.ts src/extractors/graphql.ts src/discovery/config.ts 2>/dev/null | grep -i graphql | head -20`
(The dispatcher may live in `src/ingest/pipeline.ts` or `dispatch.ts` — the grep covers both plus the config type and the extractor.) Record the exact `surface` config value and `content_type` that route bytes to `extractGraphql`. Use those literal values in Step 3's config. Note: GraphQL is detected downstream by the **surface node id prefix `srf_`** (set by `stableId("srf",[productId,"graphql"])` in `src/extractors/graphql.ts:57`) and the op `method` claim being `QUERY`/`MUTATION`/`SUBSCRIPTION` — there is NO `surface` claim to read. (Do not guess — read the dispatcher.)

- [ ] **Step 2: Create the SDL fixture**

```graphql
# tests/fixtures/graphql/minimal.graphql
type Query {
  "List all projects"
  projects(limit: Int): [Project!]!
}
type Mutation {
  "Create a project"
  createProject(input: ProjectInput!): Project!
}
type Project { id: ID!, name: String! }
input ProjectInput { name: String! }
```

- [ ] **Step 3: Write the failing GraphQL conformance test**

Add to `tests/renderers/oas.test.ts` (use the surface/content_type literals from Step 1; the loadBytes returns the SDL fixture bytes):

```ts
describe("renderSyntheticOpenApi (GraphQL-sourced — no OpenAPI spec)", () => {
  let tmp: string; let graph: GraphDb;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "sk-oas-gql-")); graph = openGraph(join(tmp, "g.db")); });
  afterEach(() => { graph.close(); rmSync(tmp, { recursive: true, force: true }); });

  test("produces operations from a GraphQL SDL graph (the differentiator gate)", async () => {
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/graphql/minimal.graphql"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: "gql.example", github_org: null },
      // surface + content_type: use the literals confirmed in Step 1
      sources: [{ surface: "graphql", url: "https://gql.example/graphql", sha256: sha, content_type: "application/graphql", fetched_at: NOW }],
      coverage: "bronze",
    };
    await ingestConfig({ db: graph.db, config, productId: "p-gql", loadBytes: async () => bytes, now: () => NOW });
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-gql", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) }));
    const pathKeys = Object.keys(doc.paths);
    expect(pathKeys.some(k => k.includes("projects"))).toBe(true);
    expect(pathKeys.some(k => k.includes("createProject"))).toBe(true);
    for (const k of pathKeys) expect(doc.paths[k].post).toBeDefined();
  });
});
```

- [ ] **Step 4: Run — confirm RED then make GREEN**

Run: `npx vitest run tests/renderers/oas.test.ts -t "GraphQL-sourced"`
Expected first: FAIL (ingest config surface/content_type not yet matching Step 1's confirmed literals). The GraphQL projection path is already implemented in Task 2 — `listOperations` sets `isGraphql = surfaceId.startsWith("srf_")` and the render loop also treats `method ∈ {QUERY,MUTATION,SUBSCRIPTION}` as GraphQL. If the test still yields zero paths after fixing the ingest config: confirm via `sqlite3`/a debug print that a `srf_…` surface node and `operation` children with `method=QUERY/MUTATION` claims were actually persisted (i.e. the GraphQL extractor ran). Root-cause in the ingest config (wrong `surface`/`content_type` literal) or the extractor — do NOT weaken the assertion and do NOT add a `surface`-claim read (none is written). Iterate until PASS.

- [ ] **Step 5: Preflight + commit**

```bash
npm run typecheck && npx vitest run tests/renderers/oas.test.ts; echo "EXIT=$?"
git add tests/fixtures/graphql/minimal.graphql tests/renderers/oas.test.ts src/renderers/oas.ts
git commit -m "test(oas): GraphQL-sourced conformance gate (no-OpenAPI differentiator)"
```

---

### Task 5: O-SHAPE apply — operationId rename, tag override, x-skillship-codegen stamping

**Files:**
- Modify: `src/overlays/codegen.ts` (add `applyOverlayToDoc`)
- Modify: `src/renderers/oas.ts` (call `applyOverlayToDoc` before serialising)
- Test: `tests/overlays/codegen.test.ts` (add apply cases)

- [ ] **Step 1: Add failing tests**

```ts
import { applyOverlayToDoc } from "../../src/overlays/codegen.js";

test("applyOverlayToDoc renames operationId and overrides tags", () => {
  const doc: any = { paths: { "/p": { get: { operationId: "op_a", tags: ["old"] } } } };
  applyOverlayToDoc(doc, CodegenOverlaySchema.parse({ resources: { op_a: { namespace: "users", rename: "list" } } }));
  expect(doc.paths["/p"].get.operationId).toBe("list");
  expect(doc.paths["/p"].get.tags).toEqual(["users"]);
});

test("applyOverlayToDoc stamps document-level x-skillship-codegen", () => {
  const doc: any = { paths: {} };
  applyOverlayToDoc(doc, CodegenOverlaySchema.parse({ pagination: { style: "cursor" }, streaming: ["op_b"] }));
  expect(doc["x-skillship-codegen"].pagination.style).toBe("cursor");
  expect(doc["x-skillship-codegen"].streaming).toEqual(["op_b"]);
});
```

- [ ] **Step 2: Run — confirm RED**

Run: `npx vitest run tests/overlays/codegen.test.ts -t "applyOverlayToDoc"`
Expected: FAIL — `applyOverlayToDoc` is not exported.

- [ ] **Step 3: Implement `applyOverlayToDoc` in `src/overlays/codegen.ts`**

```ts
export function applyOverlayToDoc(doc: Record<string, any>, overlay: CodegenOverlay): void {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, any>>;
  for (const pathKey of Object.keys(paths).sort()) {
    const item = paths[pathKey]!;
    for (const method of Object.keys(item).sort()) {
      const op = item[method];
      if (op === null || typeof op !== "object") continue;
      const rule = overlay.resources[op.operationId as string];
      if (rule === undefined) continue;
      if (rule.rename !== undefined) op.operationId = rule.rename;
      op.tags = [rule.namespace];
    }
  }
  doc["x-skillship-codegen"] = {
    pagination: overlay.pagination ?? null,
    retries: overlay.retries ?? null,
    auth: overlay.auth ?? null,
    streaming: [...overlay.streaming].sort(),
    webhooks: overlay.webhooks ?? null,
  };
}
```

- [ ] **Step 4: Wire into R-OAS**

In `src/renderers/oas.ts`, import `applyOverlayToDoc` and call it on `doc` immediately before `return JSON.stringify(...)`:

```ts
import { applyOverlayToDoc } from "../overlays/codegen.js";
// ...
  applyOverlayToDoc(doc as Record<string, unknown>, input.overlay);
  return JSON.stringify(doc, null, 2);
```

Add a test in `tests/renderers/oas.test.ts` asserting an overlay with `resources` changes the emitted `operationId`, and that determinism still holds with an overlay applied.

- [ ] **Step 5: Run — confirm GREEN**

Run: `npx vitest run tests/overlays/codegen.test.ts tests/renderers/oas.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Preflight + commit**

```bash
npm run typecheck && npx vitest run; echo "EXIT=$?"
git add src/overlays/codegen.ts src/renderers/oas.ts tests/overlays/codegen.test.ts tests/renderers/oas.test.ts
git commit -m "feat(overlay): applyOverlayToDoc — rename, tag override, x-skillship-codegen"
```

---

### Task 6: Wire R-OAS into `skillship build` as `openapi.json`

**Files:**
- Modify: `src/cli/build.ts:14-20` (imports), `src/cli/build.ts:93-99` (writeAll topLevel), add `renderOas` helper near `renderMcp` (`src/cli/build.ts:146-152`)

- [ ] **Step 1: Write the failing test**

```ts
// tests/cli/build-oas.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";

describe("runBuild emits openapi.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sk-build-oas-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes a valid OpenAPI 3.1 artifact", async () => {
    const sk = join(dir, ".skillship");
    mkdirSync(join(sk, "sources"), { recursive: true });
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(sk, "sources", `${sha}.yaml`), bytes);
    writeFileSync(join(sk, "config.yaml"), [
      "product: { domain: min.example, github_org: null }",
      "sources:",
      `  - { surface: rest, url: 'https://min.example/openapi.yaml', sha256: ${sha}, content_type: 'application/openapi+yaml', fetched_at: '2026-05-19T12:00:00.000Z' }`,
      "coverage: bronze",
    ].join("\n"));
    const res = await runBuild({ in: dir, out: join(dir, "skills") });
    const oasPath = res.artifacts.find(a => a.path.endsWith("openapi.json"))?.path;
    expect(oasPath).toBeDefined();
    expect(existsSync(oasPath!)).toBe(true);
    const doc = JSON.parse(readFileSync(oasPath!, "utf8"));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/projects"]).toBeDefined();
  });
});
```

- [ ] **Step 2: Run — confirm RED**

Run: `npx vitest run tests/cli/build-oas.test.ts`
Expected: FAIL — no artifact ending `openapi.json`.

- [ ] **Step 3: Implement wiring in `src/cli/build.ts`**

Add imports:

```ts
import { renderSyntheticOpenApi } from "../renderers/oas.js";
import { loadCodegenOverlay } from "../overlays/codegen.js";
```

In `runBuild`, after `const config = parseYaml(...)` add: `const codegenOverlay = loadCodegenOverlay(opts.in);` and thread it through `WriteArgs` (add `readonly codegenOverlay: CodegenOverlay;` to the interface, set it in the `writeAll(handle.db, opts.out, { ... })` call). Import the type: `import type { CodegenOverlay } from "../overlays/codegen.js";`.

In `writeAll`, add to `topLevel` (after the `.mcp.json` entry):

```ts
    [join(skillDir, "openapi.json"), renderOas(db, args)],
```

Add helper near `renderMcp`:

```ts
function renderOas(db: Sqlite3Database, args: WriteArgs): string {
  return renderSyntheticOpenApi({
    db,
    productId: args.productId,
    productName: args.productName,
    overlay: args.codegenOverlay,
  });
}
```

- [ ] **Step 4: Run — confirm GREEN**

Run: `npx vitest run tests/cli/build-oas.test.ts`
Expected: PASS.

- [ ] **Step 5: Full preflight (existing suite must stay green) + commit**

```bash
npm run typecheck && npm test; echo "EXIT=$?"
# EXIT must be 0 and total test count >= prior 359 + new tests
git add src/cli/build.ts tests/cli/build-oas.test.ts
git commit -m "feat(build): emit synthetic openapi.json artifact from R-OAS"
```

---

### Task 7: Freeze the substrate behind committed goldens (spec §3 — gate for Plans 2/3)

**Files:**
- Create: `tests/fixtures/golden/oas-minimal.json`, `tests/fixtures/golden/oas-graphql-minimal.json`
- Test: `tests/renderers/oas-golden.test.ts`

- [ ] **Step 1: Generate the goldens from current R-OAS output**

Run a one-off script (delete after) that renders both fixtures' OAS and writes them to `tests/fixtures/golden/`. Inspect each JSON by eye for correctness (paths present, params/auth/tags sane, GraphQL ops present) before committing — these become the contract Plans 2/3 build against.

- [ ] **Step 2: Write the golden lock test**

```ts
// tests/renderers/oas-golden.test.ts — renders both fixtures, asserts
// the serialized output is byte-identical to the committed golden files.
// (Mirror the ingest setup from oas.test.ts for the rest + graphql fixtures.)
```

- [ ] **Step 3: Run — confirm GREEN (output matches committed goldens)**

Run: `npx vitest run tests/renderers/oas-golden.test.ts`
Expected: PASS — byte-identical.

- [ ] **Step 4: Full preflight + commit (the freeze point)**

```bash
npm run typecheck && npm test; echo "EXIT=$?"
git add tests/fixtures/golden/ tests/renderers/oas-golden.test.ts
git commit -m "test(oas): freeze substrate behind committed goldens (Plans 2/3 gate)"
```

- [ ] **Step 5: Tag the freeze**

```bash
git tag substrate/frozen
```

---

## Spec Amendment (RESOLVED 2026-05-19 — user signed off)

Spec §4.1 originally stated tags come "from `resource` via `acts_on`". Verified
against `src/extractors/*` + `src/graph/types.ts`: `acts_on` edges and
`resource` nodes are declared in the type unions but **no extractor emits
them**. The substrate derives the tag from the REST path's first real segment
(or `query`/`mutation`/`subscription` for GraphQL), with O-SHAPE's `resources`
overlay as the authoritative override. **User approved this amendment on
2026-05-19; spec §4.1 has been updated accordingly.** No further action — this
note is retained for provenance.

## Definition of Done (Plan 1)

- [ ] `npm run typecheck` clean; `npm test` exit 0 with the existing 359 tests still green plus new tests.
- [ ] `renderSyntheticOpenApi` produces a valid, deterministic OpenAPI 3.1 doc for the OpenAPI-sourced fixture **and** the GraphQL-sourced fixture (spec §2.1, §6 mandatory gate).
- [ ] O-SHAPE overlay loads/validates and stamps `x-skillship-codegen` + applies rename/tag overrides (spec §2.2).
- [ ] `skillship build` emits `openapi.json` (spec §3 data flow).
- [ ] Committed goldens exist and a lock test enforces them; `substrate/frozen` tag created. **Plans 2 (R-SDK) and 3 (R-MCP) may now be written/executed against this frozen artifact.**

## Plan Review Loop

After completing the plan document, dispatch a plan-document-reviewer subagent (spec path + this plan path, no session history). Fix issues, re-dispatch until approved (max 3 iterations, then surface to human).

## Execution Handoff

This plan is executed in a fresh session/worktree (per the user's workflow rule: implementation does not run in the planning context). Recommended: superpowers:subagent-driven-development (fresh subagent per task, review between tasks).
