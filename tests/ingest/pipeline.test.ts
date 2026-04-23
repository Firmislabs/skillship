import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import type {
  ConfigSourceEntry,
  SkillshipConfig,
} from "../../src/discovery/config.js";

const NOW = "2026-04-23T12:00:00.000Z";

function loadFixture(rel: string): Buffer {
  return readFileSync(join(process.cwd(), rel));
}

function entry(
  surface: ConfigSourceEntry["surface"],
  url: string,
  contentType: string,
  bytes: Buffer,
): ConfigSourceEntry {
  return {
    surface,
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    content_type: contentType,
    fetched_at: NOW,
  };
}

describe("ingestConfig (pipeline)", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillship-pipeline-"));
    graph = openGraph(join(tmp, "graph.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("creates product node + ingests a single openapi source", async () => {
    const bytes = loadFixture("tests/fixtures/openapi3/minimal.yaml");
    const e = entry(
      "rest",
      "https://supa.example/openapi.yaml",
      "application/openapi+yaml",
      bytes,
    );
    const config: SkillshipConfig = {
      product: { domain: "supa.example", github_org: null },
      sources: [e],
      coverage: "bronze",
    };
    const summary = await ingestConfig({
      db: graph.db,
      config,
      productId: "p-supa",
      loadBytes: async (sha) =>
        sha === e.sha256 ? bytes : Buffer.from(""),
      now: () => NOW,
    });
    expect(summary.sourcesProcessed).toBe(1);
    expect(summary.sourcesFailed).toBe(0);
    expect(summary.operations).toBeGreaterThan(0);
    const product = graph.db
      .prepare("SELECT kind FROM nodes WHERE id='p-supa'")
      .get() as { kind: string } | undefined;
    expect(product?.kind).toBe("product");
  });

  test("skips github.repo placeholder entries without failing", async () => {
    const ghEntry: ConfigSourceEntry = {
      surface: "rest",
      url: "https://github.com/x/y",
      sha256: "x".repeat(64),
      content_type: "application/vnd.github.repo",
      fetched_at: NOW,
    };
    const okBytes = loadFixture("tests/fixtures/openapi3/minimal.yaml");
    const okEntry = entry(
      "rest",
      "https://x/openapi.yaml",
      "application/openapi+yaml",
      okBytes,
    );
    const config: SkillshipConfig = {
      product: { domain: "x", github_org: null },
      sources: [ghEntry, okEntry],
      coverage: "bronze",
    };
    const summary = await ingestConfig({
      db: graph.db,
      config,
      productId: "p-x",
      loadBytes: async (sha) =>
        sha === okEntry.sha256 ? okBytes : Buffer.from(""),
      now: () => NOW,
    });
    expect(summary.sourcesSkipped).toBe(1);
    expect(summary.sourcesProcessed).toBe(1);
    expect(summary.sourcesFailed).toBe(0);
  });

  test("operation count across real fixtures hits Phase 3 gate of 160", async () => {
    const big = loadFixture("tests/fixtures/openapi3/bulk-160.yaml");
    const e = entry(
      "rest",
      "https://big.example/openapi.yaml",
      "application/openapi+yaml",
      big,
    );
    const config: SkillshipConfig = {
      product: { domain: "big.example", github_org: null },
      sources: [e],
      coverage: "gold",
    };
    const summary = await ingestConfig({
      db: graph.db,
      config,
      productId: "p-big",
      loadBytes: async () => big,
      now: () => NOW,
    });
    expect(summary.operations).toBeGreaterThanOrEqual(160);
    const count = graph.db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind='operation'")
      .get() as { c: number };
    expect(count.c).toBeGreaterThanOrEqual(160);
  });

  test("records failures without aborting the whole run", async () => {
    const badEntry: ConfigSourceEntry = {
      surface: "rest",
      url: "https://x/bad.json",
      sha256: "a".repeat(64),
      content_type: "application/swagger+json",
      fetched_at: NOW,
    };
    const okBytes = loadFixture("tests/fixtures/openapi3/minimal.yaml");
    const okEntry = entry(
      "rest",
      "https://x/openapi.yaml",
      "application/openapi+yaml",
      okBytes,
    );
    const config: SkillshipConfig = {
      product: { domain: "x", github_org: null },
      sources: [badEntry, okEntry],
      coverage: "bronze",
    };
    const summary = await ingestConfig({
      db: graph.db,
      config,
      productId: "p-x",
      loadBytes: async (sha) => {
        if (sha === badEntry.sha256) return Buffer.from("{not json");
        return okBytes;
      },
      now: () => NOW,
    });
    expect(summary.sourcesProcessed).toBe(1);
    expect(summary.sourcesFailed).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]?.url).toBe(badEntry.url);
  });
});
