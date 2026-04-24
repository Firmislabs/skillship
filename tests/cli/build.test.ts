import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

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

describe("runBuild", () => {
  let ctx: TmpCtx;
  beforeEach(() => {
    ctx = makeTmpCtx("skillship-build-");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("produces SKILL.md, .mcp.json, llms.txt, llms-full.txt artifacts", async () => {
    seedProject(
      ctx.dir,
      [
        {
          surface: "rest",
          url: "https://supa.example/openapi.yaml",
          contentType: "application/openapi+yaml",
          bytes: loadFixture("tests/fixtures/openapi3/minimal.yaml"),
          ext: "yaml",
        },
        {
          surface: "llms_txt",
          url: "https://supa.example/llms.txt",
          contentType: "text/plain; charset=utf-8",
          bytes: loadFixture("tests/fixtures/llms-txt/supa.txt"),
          ext: "txt",
        },
        {
          surface: "mcp",
          url: "https://supa.example/.well-known/oauth-protected-resource/mcp",
          contentType: "application/json",
          bytes: loadFixture("tests/fixtures/mcp-well-known/sample.json"),
          ext: "json",
        },
      ],
      "supa.example",
    );
    const outDir = join(ctx.dir, "skills");
    const res = await runBuild({ in: ctx.dir, out: outDir });
    expect(res.ingest.sourcesProcessed).toBe(3);
    const skillDir = join(outDir, "supa-example");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillDir, ".mcp.json"))).toBe(true);
    expect(existsSync(join(skillDir, "llms.txt"))).toBe(true);
    expect(existsSync(join(skillDir, "llms-full.txt"))).toBe(true);
    expect(existsSync(join(skillDir, "manifest.json"))).toBe(true);
  });

  test("SKILL.md has frontmatter + operation index", async () => {
    seedProject(
      ctx.dir,
      [
        {
          surface: "rest",
          url: "https://x.example/openapi.yaml",
          contentType: "application/openapi+yaml",
          bytes: loadFixture("tests/fixtures/openapi3/minimal.yaml"),
          ext: "yaml",
        },
      ],
      "x.example",
    );
    const outDir = join(ctx.dir, "skills");
    await runBuild({ in: ctx.dir, out: outDir });
    const skillMd = readFileSync(
      join(outDir, "x-example", "SKILL.md"),
      "utf8",
    );
    expect(skillMd).toMatch(/^---\nname: x-example\n/);
    expect(skillMd).toMatch(/## Operations/);
    expect(skillMd).toMatch(/GET \/projects/);
  });

  test(".mcp.json is valid JSON", async () => {
    seedProject(
      ctx.dir,
      [
        {
          surface: "mcp",
          url: "https://x.example/.well-known/oauth-protected-resource/mcp",
          contentType: "application/json",
          bytes: loadFixture("tests/fixtures/mcp-well-known/sample.json"),
          ext: "json",
        },
      ],
      "x.example",
    );
    const outDir = join(ctx.dir, "skills");
    await runBuild({ in: ctx.dir, out: outDir });
    const raw = readFileSync(join(outDir, "x-example", ".mcp.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers).toBeDefined();
    expect(Object.keys(parsed.mcpServers)).toHaveLength(1);
  });

  test("llms.txt excludes optional, llms-full.txt includes them", async () => {
    seedProject(
      ctx.dir,
      [
        {
          surface: "llms_txt",
          url: "https://supa.example/llms.txt",
          contentType: "text/plain",
          bytes: loadFixture("tests/fixtures/llms-txt/supa.txt"),
          ext: "txt",
        },
      ],
      "supa.example",
    );
    const outDir = join(ctx.dir, "skills");
    await runBuild({ in: ctx.dir, out: outDir });
    const skillDir = join(outDir, "supa-example");
    const llms = readFileSync(join(skillDir, "llms.txt"), "utf8");
    const llmsFull = readFileSync(join(skillDir, "llms-full.txt"), "utf8");
    expect(llms).not.toMatch(/\/advanced/);
    expect(llmsFull).toMatch(/\/advanced/);
  });

  test("writes manifest.json summarising sources + product id", async () => {
    seedProject(
      ctx.dir,
      [
        {
          surface: "rest",
          url: "https://x.example/openapi.yaml",
          contentType: "application/openapi+yaml",
          bytes: loadFixture("tests/fixtures/openapi3/minimal.yaml"),
          ext: "yaml",
        },
      ],
      "x.example",
    );
    const outDir = join(ctx.dir, "skills");
    await runBuild({ in: ctx.dir, out: outDir });
    const manifest = JSON.parse(
      readFileSync(join(outDir, "x-example", "manifest.json"), "utf8"),
    );
    expect(manifest.product.domain).toBe("x.example");
    expect(manifest.product.id).toMatch(/^p-/);
    expect(manifest.sources).toHaveLength(1);
    expect(manifest.sources[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("missing config.yaml → clear error", async () => {
    const outDir = join(ctx.dir, "dist");
    await expect(
      runBuild({ in: ctx.dir, out: outDir }),
    ).rejects.toThrow(/config\.yaml/);
  });
});
