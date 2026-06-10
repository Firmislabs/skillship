// tests/cli/build-base-url.test.ts
// Unit tests for readRestBaseUrl helper (Task 2 – Wave 1 baseUrl plumbing).
// Uses an inline YAML spec literal — deliberately avoids any shared fixture
// that a concurrent wave-mate may be editing.
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { readRestBaseUrl } from "../../src/renderers/claims.js";

const NOW = "2026-06-10T00:00:00.000Z";

// Minimal inline OpenAPI 3 spec WITH a servers[0].url — inlined to avoid
// shared fixture contention with the concurrent wave-mate task.
const SPEC_WITH_BASE_URL = `openapi: "3.0.3"
info:
  title: Tiny API
  version: "1.0.0"
servers:
  - url: https://api.tiny.example/v1
paths:
  /ping:
    get:
      operationId: pingGet
      summary: Ping
      responses:
        "200":
          description: pong
`;

// Minimal inline spec WITHOUT a servers entry.
const SPEC_NO_BASE_URL = `openapi: "3.0.3"
info:
  title: Tiny API No Server
  version: "1.0.0"
paths:
  /ping:
    get:
      operationId: pingGet
      summary: Ping
      responses:
        "200":
          description: pong
`;

async function ingestInlineSpec(
  graph: GraphDb,
  specYaml: string,
  productId: string,
  domain: string,
): Promise<void> {
  const bytes = Buffer.from(specYaml, "utf-8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  await ingestConfig({
    db: graph.db,
    config: {
      product: { domain, github_org: null },
      sources: [
        {
          surface: "rest",
          url: `https://${domain}/openapi.yaml`,
          sha256: sha,
          content_type: "application/openapi+yaml",
          fetched_at: NOW,
        },
      ],
      coverage: "bronze",
    },
    productId,
    loadBytes: async () => bytes,
    now: () => NOW,
  });
}

describe("readRestBaseUrl", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-base-url-"));
    graph = openGraph(join(tmp, "graph.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns the servers[0].url from the REST surface when present", async () => {
    const productId = `p-${randomUUID().slice(0, 12)}`;
    await ingestInlineSpec(graph, SPEC_WITH_BASE_URL, productId, "tiny.example");
    const result = readRestBaseUrl(graph.db, productId);
    expect(result).toBe("https://api.tiny.example/v1");
  });

  test("returns null when no servers entry is present", async () => {
    const productId = `p-${randomUUID().slice(0, 12)}`;
    await ingestInlineSpec(graph, SPEC_NO_BASE_URL, productId, "tiny-noserver.example");
    const result = readRestBaseUrl(graph.db, productId);
    expect(result).toBeNull();
  });

  test("returns null for a product with no ingested REST surface at all", () => {
    const productId = `p-${randomUUID().slice(0, 12)}`;
    // No ingest — graph is empty for this productId
    const result = readRestBaseUrl(graph.db, productId);
    expect(result).toBeNull();
  });
});
