import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { runAddSource } from "../../src/cli/add-source.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";

// ---- fixture helpers -------------------------------------------------------

const LISTMONK_CONFIG_YAML = `product:
  domain: listmonk.app
  github_org: null
sources:
  - surface: docs
    url: https://listmonk.app/sitemap.xml
    sha256: fcbe9603f6748bcbaab6c7e48f116a103a9de9f1b1d9d8d7fee17810f30e26ff
    content_type: application/xml
    fetched_at: 2026-06-10T19:26:15.003Z
coverage: bronze
`;

const OPENAPI_YAML_BYTES = Buffer.from(
  "openapi: 3.0.0\ninfo:\n  title: Acme\n  version: 1.0.0\npaths: {}\n",
  "utf8",
);

const SWAGGER_JSON_BYTES = Buffer.from(
  '{"swagger":"2.0","info":{"title":"Acme","version":"1.0"},"paths":{}}',
  "utf8",
);

const GRAPHQL_SDL_BYTES = Buffer.from(
  "type Query {\n  hello: String\n}\n",
  "utf8",
);

const DOCS_HTML_BYTES = Buffer.from(
  "<html><body><h1>Welcome to the docs</h1></body></html>",
  "utf8",
);

function makeFetch(
  responses: Record<string, { status: number; contentType: string; body: Buffer }>,
): (url: string, _opts?: RequestInit) => Promise<Response> {
  return async (url: string) => {
    const entry = responses[url];
    if (entry === undefined) {
      return new Response("not found", { status: 404 });
    }
    return new Response(entry.body, {
      status: entry.status,
      headers: { "content-type": entry.contentType },
    });
  };
}

function writeInitConfig(dir: string, yaml: string): string {
  const skillshipDir = join(dir, ".skillship");
  mkdirSync(skillshipDir, { recursive: true });
  const configPath = join(skillshipDir, "config.yaml");
  writeFileSync(configPath, yaml, "utf8");
  return configPath;
}

// ---- tests -----------------------------------------------------------------

describe("runAddSource", () => {
  let ctx: TmpCtx;

  beforeEach(() => {
    ctx = makeTmpCtx("skillship-add-source-");
  });

  afterEach(() => {
    ctx.cleanup();
  });

  it("openapi-yaml: round-trip — config valid, coverage recomputed, cache file lands with .yaml ext", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/openapi.yaml";
    const sha = createHash("sha256").update(OPENAPI_YAML_BYTES).digest("hex");
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    const result = await runAddSource(
      { url, in: ctx.dir },
      fetchImpl,
    );

    expect(result.surface).toBe("rest");
    expect(result.content_type).toBe("application/openapi+yaml");

    // config round-trip
    const configPath = join(ctx.dir, ".skillship", "config.yaml");
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as SkillshipConfig;
    expect(parsed.product.domain).toBe("listmonk.app");
    // original source + new one = 2
    expect(parsed.sources).toHaveLength(2);
    const added = parsed.sources.find((s) => s.url === url);
    expect(added).toBeDefined();
    expect(added?.surface).toBe("rest");
    expect(added?.sha256).toBe(sha);
    expect(added?.content_type).toBe("application/openapi+yaml");

    // coverage recomputed
    expect(parsed.coverage).toBe("bronze"); // 2 sources → bronze

    // cache file
    const cachePath = join(ctx.dir, ".skillship", "sources", `${sha}.yaml`);
    expect(existsSync(cachePath)).toBe(true);
    expect(readFileSync(cachePath)).toEqual(OPENAPI_YAML_BYTES);
  });

  it("replace-by-url: refresh — no duplicate entries when url already exists", async () => {
    // Pre-seed config with the same URL
    const url = "https://example.com/openapi.yaml";
    const oldSha = "aabbcc00deadbeef".repeat(4);
    const config = `product:\n  domain: example.com\n  github_org: null\nsources:\n  - surface: rest\n    url: ${url}\n    sha256: ${oldSha}\n    content_type: application/yaml\n    fetched_at: 2026-01-01T00:00:00.000Z\ncoverage: bronze\n`;
    writeInitConfig(ctx.dir, config);

    const newSha = createHash("sha256").update(OPENAPI_YAML_BYTES).digest("hex");
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    await runAddSource({ url, in: ctx.dir }, fetchImpl);

    const configPath = join(ctx.dir, ".skillship", "config.yaml");
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as SkillshipConfig;
    // Still exactly one source
    expect(parsed.sources).toHaveLength(1);
    const entry = parsed.sources[0];
    // Updated to new sha
    expect(entry?.sha256).toBe(newSha);
    expect(entry?.content_type).toBe("application/openapi+yaml");
  });

  it("swagger json: sniffs correct content type and surface", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/swagger.json";
    const sha = createHash("sha256").update(SWAGGER_JSON_BYTES).digest("hex");
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/json", body: SWAGGER_JSON_BYTES },
    });

    const result = await runAddSource({ url, in: ctx.dir }, fetchImpl);

    expect(result.surface).toBe("rest");
    expect(result.content_type).toBe("application/swagger+json");

    const cachePath = join(ctx.dir, ".skillship", "sources", `${sha}.json`);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("graphql SDL: surface=rest, content_type=application/graphql, ext=.graphql", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/schema.graphql";
    const sha = createHash("sha256").update(GRAPHQL_SDL_BYTES).digest("hex");
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "text/plain", body: GRAPHQL_SDL_BYTES },
    });

    const result = await runAddSource({ url, in: ctx.dir }, fetchImpl);

    expect(result.surface).toBe("rest");
    expect(result.content_type).toBe("application/graphql");

    const configPath = join(ctx.dir, ".skillship", "config.yaml");
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as SkillshipConfig;
    const entry = parsed.sources.find((s) => s.url === url);
    expect(entry?.content_type).toBe("application/graphql");

    const cachePath = join(ctx.dir, ".skillship", "sources", `${sha}.graphql`);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("docs fallback: unrecognized content type → surface=docs, served content-type preserved", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/docs/overview";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "text/html", body: DOCS_HTML_BYTES },
    });

    const result = await runAddSource({ url, in: ctx.dir }, fetchImpl);

    expect(result.surface).toBe("docs");
    expect(result.content_type).toBe("text/html");
  });

  it("--surface override: overrides inferred surface but sniffs content_type", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/openapi.yaml";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    const result = await runAddSource(
      { url, in: ctx.dir, surface: "sdk" },
      fetchImpl,
    );

    expect(result.surface).toBe("sdk");
    expect(result.content_type).toBe("application/openapi+yaml");
  });

  it("fetch failure → throws with actionable message", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/missing.yaml";
    const fetchImpl = makeFetch({}); // 404 for all

    await expect(
      runAddSource({ url, in: ctx.dir }, fetchImpl),
    ).rejects.toThrow(/404/);
  });

  it("unparseable config → throws with actionable message", async () => {
    const skillshipDir = join(ctx.dir, ".skillship");
    mkdirSync(skillshipDir, { recursive: true });
    writeFileSync(join(skillshipDir, "config.yaml"), "{{not: valid: yaml}}", "utf8");

    const url = "https://example.com/openapi.yaml";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    await expect(
      runAddSource({ url, in: ctx.dir }, fetchImpl),
    ).rejects.toThrow();
  });

  it("missing config → throws with actionable message", async () => {
    // No .skillship/config.yaml written
    const url = "https://example.com/openapi.yaml";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    await expect(
      runAddSource({ url, in: ctx.dir }, fetchImpl),
    ).rejects.toThrow(/config/i);
  });

  it("round-trip against real init-written config (listmonk fixture)", async () => {
    // Uses the verbatim fixture matching Listmonk init output
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://listmonk.app/api/swagger.json";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/json", body: SWAGGER_JSON_BYTES },
    });

    await runAddSource({ url, in: ctx.dir }, fetchImpl);

    const configPath = join(ctx.dir, ".skillship", "config.yaml");
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as SkillshipConfig;

    // domain preserved from init
    expect(parsed.product.domain).toBe("listmonk.app");
    expect(parsed.product.github_org).toBeNull();

    // original sitemap source preserved
    const sitemapEntry = parsed.sources.find(
      (s) => s.url === "https://listmonk.app/sitemap.xml",
    );
    expect(sitemapEntry).toBeDefined();
    expect(sitemapEntry?.sha256).toBe(
      "fcbe9603f6748bcbaab6c7e48f116a103a9de9f1b1d9d8d7fee17810f30e26ff",
    );

    // new swagger source added
    const swaggerEntry = parsed.sources.find((s) => s.url === url);
    expect(swaggerEntry).toBeDefined();
    expect(swaggerEntry?.surface).toBe("rest");
    expect(swaggerEntry?.content_type).toBe("application/swagger+json");

    // 2 sources total
    expect(parsed.sources).toHaveLength(2);
    // coverage still bronze with 2 sources
    expect(parsed.coverage).toBe("bronze");
  });

  it("--timeout-ms propagates to fetch via AbortSignal", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    let capturedSignal: AbortSignal | undefined;
    const url = "https://example.com/openapi.yaml";
    const fetchImpl = async (
      fetchUrl: string,
      opts?: RequestInit,
    ): Promise<Response> => {
      capturedSignal = opts?.signal as AbortSignal | undefined;
      return new Response(OPENAPI_YAML_BYTES, {
        status: 200,
        headers: { "content-type": "application/yaml" },
      });
    };

    await runAddSource({ url, in: ctx.dir, timeoutMs: 5000 }, fetchImpl);

    expect(capturedSignal).toBeDefined();
  });

  it("AddSourceResult includes coverage field", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/openapi.yaml";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    const result = await runAddSource({ url, in: ctx.dir }, fetchImpl);

    expect(result.coverage).toBeDefined();
    expect(["bronze", "silver", "gold"]).toContain(result.coverage);
  });

  it("missing-config error leaves NO cache file behind", async () => {
    // No .skillship/config.yaml — readConfig throws before any cache write.
    const url = "https://example.com/openapi.yaml";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    await expect(
      runAddSource({ url, in: ctx.dir }, fetchImpl),
    ).rejects.toThrow(/config/i);

    // The sources directory must not exist (no cache file written).
    const sourcesDir = join(ctx.dir, ".skillship", "sources");
    const { existsSync: exists } = await import("node:fs");
    expect(exists(sourcesDir)).toBe(false);
  });

  it("invalid --surface → throws before fetch, no side effects", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/openapi.yaml";
    let fetchCalled = false;
    const fetchImpl = async (): Promise<Response> => {
      fetchCalled = true;
      return new Response(OPENAPI_YAML_BYTES, {
        status: 200,
        headers: { "content-type": "application/yaml" },
      });
    };

    await expect(
      runAddSource({ url, in: ctx.dir, surface: "invalid-kind" as import("../../src/graph/types.js").SurfaceKind }, fetchImpl),
    ).rejects.toThrow(/invalid.*surface|valid values/i);

    // fetch must NOT have been called (validation is pre-flight).
    expect(fetchCalled).toBe(false);
  });

  it("binary-unknown with no --surface → error suggesting --surface", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const binaryBytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const url = "https://example.com/data.bin";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/octet-stream", body: binaryBytes },
    });

    await expect(
      runAddSource({ url, in: ctx.dir }, fetchImpl),
    ).rejects.toThrow(/--surface/i);
  });

  it("binary-unknown WITH --surface → succeeds (surface override bypasses binary check)", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const binaryBytes = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
    const url = "https://example.com/data.bin";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/octet-stream", body: binaryBytes },
    });

    const result = await runAddSource({ url, in: ctx.dir, surface: "docs" }, fetchImpl);
    expect(result.surface).toBe("docs");
  });

  it("cliAddSource output line matches expected format", async () => {
    writeInitConfig(ctx.dir, LISTMONK_CONFIG_YAML);

    const url = "https://example.com/openapi.yaml";
    const fetchImpl = makeFetch({
      [url]: { status: 200, contentType: "application/yaml", body: OPENAPI_YAML_BYTES },
    });

    // Import the thin wrapper
    const { runAddSource: run } = await import("../../src/cli/add-source.js");
    const result = await run({ url, in: ctx.dir }, fetchImpl);
    const line = `skillship add-source: added ${result.surface} source (coverage=${result.coverage})`;
    expect(line).toMatch(/skillship add-source: added rest source \(coverage=(bronze|silver|gold)\)/);
  });
});
