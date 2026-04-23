import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import {
  renderLlmsTxt,
  renderLlmsFullTxt,
} from "../../src/renderers/llmsTxt.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-04-23T12:00:00.000Z";

async function seedLlmsTxt(
  graph: GraphDb,
  productId: string,
): Promise<void> {
  const bytes = readFileSync(
    join(process.cwd(), "tests/fixtures/llms-txt/supa.txt"),
  );
  const sha = createHash("sha256").update(bytes).digest("hex");
  const config: SkillshipConfig = {
    product: { domain: "supa.example", github_org: null },
    sources: [
      {
        surface: "llms_txt",
        url: "https://supa.example/llms.txt",
        sha256: sha,
        content_type: "text/plain; charset=utf-8",
        fetched_at: NOW,
      },
    ],
    coverage: "bronze",
  };
  await ingestConfig({
    db: graph.db,
    config,
    productId,
    loadBytes: async () => bytes,
    now: () => NOW,
  });
}

describe("renderLlmsTxt / renderLlmsFullTxt", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillship-llms-"));
    graph = openGraph(join(tmp, "graph.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("llms.txt starts with product header + description", async () => {
    await seedLlmsTxt(graph, "p-supa");
    const out = renderLlmsTxt({
      db: graph.db,
      productId: "p-supa",
      productName: "Supa",
      productDescription: "Postgres-backed backend platform",
    });
    expect(out.startsWith("# Supa\n> Postgres-backed backend platform\n")).toBe(
      true,
    );
  });

  test("llms.txt excludes pages with tier=optional", async () => {
    await seedLlmsTxt(graph, "p-supa");
    const out = renderLlmsTxt({
      db: graph.db,
      productId: "p-supa",
      productName: "Supa",
      productDescription: "x",
    });
    expect(out).toMatch(/\/docs\/getting-started/);
    expect(out).toMatch(/\/docs\/reference/);
    expect(out).toMatch(/\/examples\/basic/);
    expect(out).not.toMatch(/\/advanced/);
    expect(out).not.toMatch(/\/migration/);
  });

  test("llms-full.txt includes optional pages too", async () => {
    await seedLlmsTxt(graph, "p-supa");
    const out = renderLlmsFullTxt({
      db: graph.db,
      productId: "p-supa",
      productName: "Supa",
      productDescription: "x",
    });
    expect(out).toMatch(/\/docs\/getting-started/);
    expect(out).toMatch(/\/advanced/);
    expect(out).toMatch(/\/migration/);
  });

  test("pages grouped under H2 sections by category", async () => {
    await seedLlmsTxt(graph, "p-supa");
    const out = renderLlmsFullTxt({
      db: graph.db,
      productId: "p-supa",
      productName: "Supa",
      productDescription: "x",
    });
    expect(out).toMatch(/^## Docs$/m);
    expect(out).toMatch(/^## Examples$/m);
    expect(out).toMatch(/^## Optional$/m);
  });

  test("each page rendered as '- [title](url)' markdown link", async () => {
    await seedLlmsTxt(graph, "p-supa");
    const out = renderLlmsFullTxt({
      db: graph.db,
      productId: "p-supa",
      productName: "Supa",
      productDescription: "x",
    });
    expect(out).toMatch(
      /- \[Getting Started\]\(https:\/\/supa\.example\/docs\/getting-started\)/,
    );
    expect(out).toMatch(
      /- \[Advanced tuning\]\(https:\/\/supa\.example\/advanced\)/,
    );
  });

  test("empty product → minimal header only", () => {
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES ('p-empty', 'product', NULL, @now, @now)`,
      )
      .run({ now: NOW });
    const out = renderLlmsTxt({
      db: graph.db,
      productId: "p-empty",
      productName: "Empty",
      productDescription: "nothing yet",
    });
    expect(out.trim()).toBe("# Empty\n> nothing yet");
  });

  test("doc_pages without category claim land under a 'Docs' section", () => {
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES
           ('p-nc', 'product', NULL, @now, @now),
           ('dp-1', 'doc_page', 'p-nc', @now, @now)`,
      )
      .run({ now: NOW });
    graph.db
      .prepare(
        `INSERT INTO sources (id, surface, url, content_type, fetched_at, bytes, cache_path)
         VALUES ('s-nc', 'docs', 'http://x', 'text/markdown', @now, 0, '/tmp/x')`,
      )
      .run({ now: NOW });
    const insert = graph.db.prepare(
      `INSERT INTO claims
         (id, node_id, field, value_json, source_id, extractor, extracted_at,
          span_start, span_end, span_path, confidence, chosen, rejection_rationale)
       VALUES
         (@id, @node, @field, @val, 's-nc', 'docs-md@1', @now,
          NULL, NULL, '$', 'attested', 0, NULL)`,
    );
    insert.run({
      id: "c-u",
      node: "dp-1",
      field: "url",
      val: JSON.stringify("https://x/q"),
      now: NOW,
    });
    insert.run({
      id: "c-t",
      node: "dp-1",
      field: "title",
      val: JSON.stringify("Q"),
      now: NOW,
    });
    const out = renderLlmsFullTxt({
      db: graph.db,
      productId: "p-nc",
      productName: "N",
      productDescription: "d",
    });
    expect(out).toMatch(/## Docs/);
    expect(out).toMatch(/- \[Q\]\(https:\/\/x\/q\)/);
  });
});
