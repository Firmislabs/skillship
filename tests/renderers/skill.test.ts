import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderSkillMd } from "../../src/renderers/skill.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-04-23T12:00:00.000Z";

async function ingestOpenapi(
  graph: GraphDb,
  fixture: string,
  productId: string,
  domain: string,
): Promise<void> {
  const bytes = readFileSync(join(process.cwd(), fixture));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const config: SkillshipConfig = {
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
  };
  await ingestConfig({
    db: graph.db,
    config,
    productId,
    loadBytes: async () => bytes,
    now: () => NOW,
  });
}

describe("renderSkillMd", () => {
  let tmp: string;
  let graph: GraphDb;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "skillship-skill-"));
    graph = openGraph(join(tmp, "graph.db"));
  });

  afterEach(() => {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("emits valid YAML frontmatter with name, description, allowed-tools", async () => {
    await ingestOpenapi(
      graph,
      "tests/fixtures/openapi3/minimal.yaml",
      "p-min",
      "min.example",
    );
    const out = renderSkillMd({
      db: graph.db,
      productId: "p-min",
      productName: "min.example",
      allowedTools: ["Read", "Bash"],
    });
    const fm = extractFrontmatter(out);
    expect(fm).toMatch(/^name:\s*min-example/m);
    expect(fm).toMatch(/^description:\s*.+/m);
    expect(fm).toMatch(/^allowed-tools:\s*Read,\s*Bash$/m);
  });

  test("lists surfaces with their operation counts", async () => {
    await ingestOpenapi(
      graph,
      "tests/fixtures/openapi3/minimal.yaml",
      "p-min",
      "min.example",
    );
    const out = renderSkillMd({
      db: graph.db,
      productId: "p-min",
      productName: "min.example",
      allowedTools: ["Read"],
    });
    expect(out).toMatch(/## Surfaces/);
    expect(out).toMatch(/- rest .*\b2\b.*operation/);
  });

  test("includes an operation index with method + path + ref link", async () => {
    await ingestOpenapi(
      graph,
      "tests/fixtures/openapi3/minimal.yaml",
      "p-min",
      "min.example",
    );
    const out = renderSkillMd({
      db: graph.db,
      productId: "p-min",
      productName: "min.example",
      allowedTools: ["Read"],
    });
    expect(out).toMatch(/## Operations/);
    expect(out).toMatch(/GET\s+\/projects/);
    expect(out).toMatch(/POST\s+\/projects/);
    expect(out).toMatch(/\[details\]\(references\/op_[a-f0-9]+\.md\)/);
  });

  test("truncates the operation index at the configured cap", async () => {
    await ingestOpenapi(
      graph,
      "tests/fixtures/openapi3/bulk-160.yaml",
      "p-big",
      "big.example",
    );
    const out = renderSkillMd({
      db: graph.db,
      productId: "p-big",
      productName: "big.example",
      allowedTools: ["Read"],
      operationIndexCap: 5,
    });
    const opLines = out
      .split("\n")
      .filter((l) => /^- `[A-Z]+ \//.test(l));
    expect(opLines.length).toBe(5);
    expect(out).toMatch(/\+ 155 more operations/);
  });

  test("product with zero surfaces still renders minimal valid skill", () => {
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES ('p-empty', 'product', NULL, @now, @now)`,
      )
      .run({ now: NOW });
    const out = renderSkillMd({
      db: graph.db,
      productId: "p-empty",
      productName: "empty.example",
      allowedTools: ["Read"],
    });
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toMatch(/# empty\.example/);
    expect(out).toMatch(/No surfaces discovered/);
  });

  test("sanitises name slug (lowercase, hyphens, no dots)", () => {
    graph.db
      .prepare(
        `INSERT INTO nodes (id, kind, parent_id, created_at, updated_at)
         VALUES ('p-dotted', 'product', NULL, @now, @now)`,
      )
      .run({ now: NOW });
    const out = renderSkillMd({
      db: graph.db,
      productId: "p-dotted",
      productName: "My Cool.API_v2",
      allowedTools: ["Read"],
    });
    const fm = extractFrontmatter(out);
    expect(fm).toMatch(/^name:\s*my-cool-api-v2$/m);
  });
});

function extractFrontmatter(out: string): string {
  const m = /^---\n([\s\S]*?)\n---/.exec(out);
  if (m === null) throw new Error("no frontmatter");
  return m[1]!;
}
