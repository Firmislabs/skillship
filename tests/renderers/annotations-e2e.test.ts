// tests/renderers/annotations-e2e.test.ts
// End-to-end pin test (Task 1):
//   real ingest (agent-minimal.yaml) → real OAS render
// Proves that x-skillship-annotations from the source spec flows through the
// ingest → claim → synthetic OAS projection pipeline end-to-end, with no
// hand-built documents or manual claim seeding.

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

const NOW = "2026-06-10T00:00:00.000Z";
const EMPTY_OVERLAY = CodegenOverlaySchema.parse({});

describe("annotations end-to-end: x-skillship-annotations ingest + project", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-ann-e2e-"));
    graph = openGraph(join(tmp, "g.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("POST /items in agent-minimal.yaml carries x-skillship-annotations.destructive = true in rendered synthetic OAS", async () => {
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/agent-minimal.yaml"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: "agentmin.example", github_org: null },
      sources: [
        {
          surface: "rest",
          url: "https://api.agentmin.test/openapi.yaml",
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
      productId: "p-ann-e2e",
      loadBytes: async () => bytes,
      now: () => NOW,
    });

    expect(summary.sourcesFailed).toBe(0);
    expect(summary.operations).toBeGreaterThanOrEqual(1);

    const oasJson = renderSyntheticOpenApi({
      db: graph.db,
      productId: "p-ann-e2e",
      productName: "agentmin.example",
      overlay: EMPTY_OVERLAY,
    });

    const doc = JSON.parse(oasJson) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    // Find the POST /items operation
    const itemsPath = Object.keys(doc.paths).find((k) => k === "/items");
    expect(itemsPath).toBeDefined();

    const postOp = doc.paths[itemsPath!]?.["post"];
    expect(postOp).toBeDefined();

    // The annotation must be projected
    const ann = postOp?.["x-skillship-annotations"] as Record<string, unknown> | undefined;
    expect(ann).toBeDefined();
    expect(ann?.["destructive"]).toBe(true);
  });

  test("GET /items carries readOnly:true (derived from HTTP method) but NOT destructive", async () => {
    // GET ops emit is_read_only=true as a derived claim (not from x-skillship-annotations).
    // The renderer projects this as x-skillship-annotations.readOnly=true.
    // This test pins that the GET op does NOT have destructive set (only POST does).
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/agent-minimal.yaml"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: "agentmin2.example", github_org: null },
      sources: [
        {
          surface: "rest",
          url: "https://api.agentmin.test/openapi2.yaml",
          sha256: sha,
          content_type: "application/openapi+yaml",
          fetched_at: NOW,
        },
      ],
      coverage: "bronze",
    };

    await ingestConfig({
      db: graph.db,
      config,
      productId: "p-ann-e2e2",
      loadBytes: async () => bytes,
      now: () => NOW,
    });

    const oasJson = renderSyntheticOpenApi({
      db: graph.db,
      productId: "p-ann-e2e2",
      productName: "agentmin2.example",
      overlay: EMPTY_OVERLAY,
    });

    const doc = JSON.parse(oasJson) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    const itemsPath = Object.keys(doc.paths).find((k) => k === "/items");
    expect(itemsPath).toBeDefined();
    const getOp = doc.paths[itemsPath!]?.["get"];
    expect(getOp).toBeDefined();
    // GET /items has readOnly derived from its HTTP method — no destructive claim
    const ann = getOp?.["x-skillship-annotations"] as Record<string, unknown> | undefined;
    expect(ann?.["readOnly"]).toBe(true);
    expect(ann?.["destructive"]).toBeUndefined();
  });
});
