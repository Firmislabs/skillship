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
  });

  test("derives a tag from the first REST path segment", async () => {
    await ingestOpenapi(graph);
    const doc = JSON.parse(renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) }));
    expect(doc.paths["/projects"].get.tags).toEqual(["projects"]);
  });
});
