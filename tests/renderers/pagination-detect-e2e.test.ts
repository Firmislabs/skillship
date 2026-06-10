// tests/renderers/pagination-detect-e2e.test.ts
// End-to-end pin test (Task 6b Step 3):
//   real ingest → real OAS render → real detectPagination
// Proves that the inline schema_json passthrough activates tier-3 auto-detect
// without any hand-built OAS or manual claim seeding.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderSyntheticOpenApi } from "../../src/renderers/oas.js";
import { extractOperations } from "../../src/renderers/sdk-utils.js";
import { detectPagination } from "../../src/renderers/pagination-detect.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-06-10T00:00:00.000Z";
const EMPTY_OVERLAY = CodegenOverlaySchema.parse({});

// An inline-schema OAS spec: the 200 response has an OBJECT schema directly
// in the spec (NOT a $ref). This is the exact case that Task 6b enables.
const INLINE_SCHEMA_SPEC = `
openapi: 3.1.0
info:
  title: Inline Schema API
  version: 1.0.0
paths:
  /items:
    get:
      operationId: listItems
      summary: List items with cursor pagination
      parameters:
        - name: cursor
          in: query
          required: false
          schema:
            type: string
        - name: limit
          in: query
          required: false
          schema:
            type: integer
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      type: object
                  next_cursor:
                    type: string
  /items/{id}:
    get:
      operationId: getItem
      summary: Get a single item
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id:
                    type: string
                  name:
                    type: string
`;

describe("pagination-detect end-to-end: inline schema passthrough activates auto-detect", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-pd-e2e-"));
    graph = openGraph(join(tmp, "g.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("ingest inline-schema spec → render → detectPagination returns cursor plan for list op", async () => {
    const bytes = Buffer.from(INLINE_SCHEMA_SPEC, "utf8");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: "inlineschema.example", github_org: null },
      sources: [
        {
          surface: "rest",
          url: "https://inlineschema.example/openapi.yaml",
          sha256: sha,
          content_type: "application/openapi+yaml",
          fetched_at: NOW,
        },
      ],
      coverage: "bronze",
    };

    const summary = await ingestConfig({
      db: graph.db,
      config,
      productId: "p-e2e",
      loadBytes: async () => bytes,
      now: () => NOW,
    });

    expect(summary.sourcesFailed).toBe(0);
    expect(summary.operations).toBeGreaterThanOrEqual(1);

    const oasJson = renderSyntheticOpenApi({
      db: graph.db,
      productId: "p-e2e",
      productName: "inlineschema.example",
      overlay: EMPTY_OVERLAY,
    });

    const doc = JSON.parse(oasJson) as {
      paths: Record<string, unknown>;
    };

    // Rendered OAS must include the list operation path
    const pathKeys = Object.keys(doc.paths);
    const listPath = pathKeys.find((k) => k.includes("items") && !k.includes("{"));
    expect(listPath).toBeDefined();

    // Real detectPagination call — no hand-built OAS
    const ops = extractOperations(oasJson);
    expect(ops.length).toBeGreaterThanOrEqual(1);

    const planMap = detectPagination(ops, oasJson, EMPTY_OVERLAY);

    // Find the list operation — its operationId is a hash, so we look it up by path
    const listOp = ops.find(
      (o) => o.path === listPath && o.method === "GET",
    );
    expect(listOp).toBeDefined();

    // The list op must have a cursor plan (this is what was dead before Task 6b)
    expect(planMap.has(listOp!.operationId)).toBe(true);
    const plan = planMap.get(listOp!.operationId)!;
    expect(plan.style).toBe("cursor");
    expect(plan.requestParam).toBe("cursor");
    expect(plan.nextField).toBe("next_cursor");
    expect(plan.itemsField).toBe("data");

    // The single-item GET should NOT be detected as paginated
    const getOp = ops.find((o) => o.path.includes("{id}") && o.method === "GET");
    if (getOp !== undefined) {
      expect(planMap.has(getOp.operationId)).toBe(false);
    }
  });
});
