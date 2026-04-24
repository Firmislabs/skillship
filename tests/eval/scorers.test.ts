import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { runBuild } from "../../src/cli/build.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";
import {
  scoreCoverage,
  scoreFormat,
  scoreGrounding,
} from "../../eval/scorers.js";

interface SeedSource {
  readonly surface: SkillshipConfig["sources"][number]["surface"];
  readonly url: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly ext: string;
}

const NOW = "2026-04-23T12:00:00.000Z";

function seedProject(dir: string, sources: SeedSource[], domain: string): void {
  const skDir = join(dir, ".skillship");
  const srcDir = join(skDir, "sources");
  mkdirSync(srcDir, { recursive: true });
  const entries = sources.map((s) => {
    const sha = createHash("sha256").update(s.bytes).digest("hex");
    writeFileSync(join(srcDir, `${sha}.${s.ext}`), s.bytes);
    return {
      surface: s.surface,
      url: s.url,
      sha256: sha,
      content_type: s.contentType,
      fetched_at: NOW,
    };
  });
  const config = {
    product: { domain, github_org: null },
    sources: entries,
    coverage: "bronze" as const,
  };
  writeFileSync(join(skDir, "config.yaml"), stringifyYaml(config), "utf8");
}

function loadFixture(rel: string): Buffer {
  return readFileSync(join(process.cwd(), rel));
}

async function buildFixtureProject(ctx: TmpCtx): Promise<{
  db: Database.Database;
  sourcesDir: string;
  productId: string;
  outDir: string;
}> {
  seedProject(
    ctx.dir,
    [
      {
        surface: "rest",
        url: "https://acme.example/openapi.yaml",
        contentType: "application/openapi+yaml",
        bytes: loadFixture("tests/fixtures/openapi3/minimal.yaml"),
        ext: "yaml",
      },
    ],
    "acme.example",
  );
  const outDir = join(ctx.dir, "dist");
  const res = await runBuild({ in: ctx.dir, out: outDir });
  const db = new Database(join(ctx.dir, ".skillship", "graph.sqlite"));
  return {
    db,
    sourcesDir: join(ctx.dir, ".skillship", "sources"),
    productId: res.productId,
    outDir,
  };
}

describe("scoreCoverage", () => {
  let ctx: TmpCtx;
  beforeEach(() => {
    ctx = makeTmpCtx("skillship-eval-cov-");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("counts hits for expected ops present in the graph", async () => {
    const { db, productId } = await buildFixtureProject(ctx);
    const report = scoreCoverage(db, productId, [
      { method: "GET", path: "/projects" },
      { method: "POST", path: "/projects" },
    ]);
    expect(report.expected).toBe(2);
    expect(report.hits).toHaveLength(2);
    expect(report.misses).toHaveLength(0);
    expect(report.hitRate).toBe(1);
  });

  test("reports misses for ops absent from the graph", async () => {
    const { db, productId } = await buildFixtureProject(ctx);
    const report = scoreCoverage(db, productId, [
      { method: "GET", path: "/projects" },
      { method: "DELETE", path: "/not-there" },
    ]);
    expect(report.hits.map((o) => o.path)).toEqual(["/projects"]);
    expect(report.misses).toEqual([
      { method: "DELETE", path: "/not-there" },
    ]);
    expect(report.hitRate).toBe(0.5);
  });

  test("matches method case-insensitively", async () => {
    const { db, productId } = await buildFixtureProject(ctx);
    const report = scoreCoverage(db, productId, [
      { method: "get", path: "/projects" },
    ]);
    expect(report.hitRate).toBe(1);
  });

  test("empty expected list → hitRate=1", async () => {
    const { db, productId } = await buildFixtureProject(ctx);
    const report = scoreCoverage(db, productId, []);
    expect(report.hitRate).toBe(1);
    expect(report.expected).toBe(0);
  });
});

describe("scoreGrounding", () => {
  let ctx: TmpCtx;
  beforeEach(() => {
    ctx = makeTmpCtx("skillship-eval-grd-");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("every claim resolves to a source row + bytes on disk", async () => {
    const { db, sourcesDir } = await buildFixtureProject(ctx);
    const report = scoreGrounding(db, sourcesDir, 50);
    expect(report.sampled).toBeGreaterThan(0);
    expect(report.resolved).toBe(report.sampled);
    expect(report.unresolved).toHaveLength(0);
    expect(report.hitRate).toBe(1);
  });

  test("reports unresolved when source bytes are missing on disk", async () => {
    const { db, sourcesDir } = await buildFixtureProject(ctx);
    const emptyDir = join(ctx.dir, "empty-sources");
    mkdirSync(emptyDir, { recursive: true });
    const report = scoreGrounding(db, emptyDir, 5);
    expect(report.resolved).toBe(0);
    expect(report.unresolved.length).toBeGreaterThan(0);
    expect(existsSync(sourcesDir)).toBe(true);
  });

  test("sampleSize caps returned sample", async () => {
    const { db, sourcesDir } = await buildFixtureProject(ctx);
    const report = scoreGrounding(db, sourcesDir, 3);
    expect(report.sampled).toBeLessThanOrEqual(3);
  });
});

describe("scoreFormat", () => {
  let ctx: TmpCtx;
  beforeEach(() => {
    ctx = makeTmpCtx("skillship-eval-fmt-");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("ok=true when skill dir passes quick_validate.py", async () => {
    const { outDir } = await buildFixtureProject(ctx);
    const skillDir = join(outDir, "acme-example");
    const report = scoreFormat(skillDir);
    expect(report.ok).toBe(true);
    expect(report.message).toMatch(/valid/i);
  });

  test("ok=false when skill dir is empty", () => {
    const emptyDir = join(ctx.dir, "empty-skill");
    mkdirSync(emptyDir, { recursive: true });
    const report = scoreFormat(emptyDir);
    expect(report.ok).toBe(false);
    expect(report.message).toMatch(/SKILL\.md not found/);
  });
});
