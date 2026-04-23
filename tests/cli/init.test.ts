import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createHash } from "node:crypto";
import { runInit } from "../../src/cli/init.js";
import type { GithubRepo } from "../../src/discovery/github.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";
import type { GithubBlob } from "../../src/resolvers/githubSpecs.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";
import {
  startTestServer,
  type RouteMap,
  type TestServer,
} from "../helpers-http.js";

describe("runInit (CLI smoke)", () => {
  let ctx: TmpCtx;
  let server: TestServer;

  beforeEach(async () => {
    ctx = makeTmpCtx();
  });

  afterEach(async () => {
    await server.close();
    ctx.cleanup();
  });

  async function start(routes: RouteMap): Promise<string> {
    server = await startTestServer(routes);
    return server.url;
  }

  it("crawls local server, stores sources, writes config.yaml", async () => {
    const baseUrl = await start({
      "/llms.txt": {
        status: 200,
        contentType: "text/plain",
        body: "# Acme docs\n\n- [REST](/rest)\n",
      },
      "/sitemap.xml": {
        status: 200,
        contentType: "application/xml",
        body: '<?xml version="1.0"?><urlset></urlset>',
      },
      "/api/openapi.json": {
        status: 200,
        contentType: "application/json",
        body: '{"openapi":"3.0.0","info":{"title":"Acme"}}',
      },
    });
    const result = await runInit({
      domain: baseUrl,
      github: null,
      out: ctx.dir,
      timeoutMs: 2000,
    });
    expect(existsSync(result.configPath)).toBe(true);
    const parsed = parseYaml(
      readFileSync(result.configPath, "utf8"),
    ) as SkillshipConfig;
    expect(parsed.product.domain).toBe(baseUrl);
    expect(parsed.product.github_org).toBeNull();
    const surfaces = parsed.sources.map((s) => s.surface).sort();
    expect(surfaces).toEqual(["docs", "llms_txt", "rest"]);
    expect(parsed.coverage).toBe("bronze");
    expect(
      existsSync(join(ctx.dir, ".skillship", "graph.sqlite")),
    ).toBe(true);
    const expectedSources = join(ctx.dir, ".skillship", "sources");
    expect(existsSync(expectedSources)).toBe(true);
  });

  it("augments sources with injected github signal repos", async () => {
    const baseUrl = await start({
      "/llms.txt": {
        status: 200,
        contentType: "text/plain",
        body: "# Supa\n",
      },
    });
    const ghLister = async (org: string): Promise<GithubRepo[]> => {
      expect(org).toBe("supabase");
      return [
        { name: "supabase", html_url: "https://github.com/supabase/supabase" },
        { name: "cli", html_url: "https://github.com/supabase/cli" },
        {
          name: "postgrest-openapi",
          html_url: "https://github.com/supabase/postgrest-openapi",
        },
        {
          name: "supabase-mcp",
          html_url: "https://github.com/supabase/supabase-mcp",
        },
        { name: "sdk-node", html_url: "https://github.com/supabase/sdk-node" },
        { name: "supabase-js", html_url: "https://github.com/supabase/supabase-js" },
      ];
    };
    const result = await runInit({
      domain: baseUrl,
      github: "supabase",
      out: ctx.dir,
      timeoutMs: 2000,
      githubLister: ghLister,
    });
    const parsed = parseYaml(
      readFileSync(result.configPath, "utf8"),
    ) as SkillshipConfig;
    expect(parsed.product.github_org).toBe("supabase");
    const urls = parsed.sources.map((s) => s.url).sort();
    expect(urls).toContain("https://github.com/supabase/cli");
    expect(urls).toContain("https://github.com/supabase/postgrest-openapi");
    expect(urls).toContain("https://github.com/supabase/supabase-mcp");
    expect(urls).toContain("https://github.com/supabase/sdk-node");
    // supabase-js matches the -js suffix heuristic.
    expect(urls).toContain("https://github.com/supabase/supabase-js");
    expect(urls).not.toContain("https://github.com/supabase/supabase");
  });

  it("expands github.repo placeholders via injected fetcher + stores bytes", async () => {
    const baseUrl = await start({
      "/llms.txt": { status: 200, contentType: "text/plain", body: "# x\n" },
    });
    const openapiBytes = Buffer.from(
      "openapi: 3.0.0\ninfo:\n  title: Acme\n  version: 1.0.0\n",
    );
    const openapiSha = createHash("sha256").update(openapiBytes).digest("hex");
    const ghLister = async (): Promise<GithubRepo[]> => [
      { name: "openapi", html_url: "https://github.com/acme/openapi" },
    ];
    const fetcher = async (
      repoUrl: string,
    ): Promise<readonly GithubBlob[]> => {
      if (repoUrl !== "https://github.com/acme/openapi") return [];
      return [{ path: "openapi.yaml", bytes: openapiBytes }];
    };
    const result = await runInit({
      domain: baseUrl,
      github: "acme",
      out: ctx.dir,
      timeoutMs: 2000,
      githubLister: ghLister,
      githubRepoFetcher: fetcher,
    });
    const parsed = parseYaml(
      readFileSync(result.configPath, "utf8"),
    ) as SkillshipConfig;
    const placeholders = parsed.sources.filter(
      (s) => s.content_type === "application/vnd.github.repo",
    );
    expect(placeholders).toEqual([]);
    const rest = parsed.sources.find(
      (s) => s.content_type === "application/openapi+yaml",
    );
    expect(rest).toBeDefined();
    expect(rest?.sha256).toBe(openapiSha);
    expect(rest?.url).toBe(
      "https://github.com/acme/openapi/blob/HEAD/openapi.yaml",
    );
    const cached = join(ctx.dir, ".skillship", "sources", `${openapiSha}.yaml`);
    expect(existsSync(cached)).toBe(true);
    expect(readFileSync(cached)).toEqual(openapiBytes);
  });

  it("emits GOLD coverage when signals total >=10", async () => {
    const baseUrl = await start({
      "/llms.txt": {
        status: 200,
        contentType: "text/plain",
        body: "# x\n",
      },
      "/sitemap.xml": {
        status: 200,
        contentType: "application/xml",
        body: "<urlset></urlset>",
      },
      "/api/openapi.json": {
        status: 200,
        contentType: "application/json",
        body: "{}",
      },
      "/api/v1/openapi.json": {
        status: 200,
        contentType: "application/json",
        body: "{}",
      },
    });
    const ghLister = async (): Promise<GithubRepo[]> => [
      { name: "cli", html_url: "https://github.com/acme/cli" },
      { name: "cli-v2", html_url: "https://github.com/acme/cli-v2" },
      { name: "mcp-server", html_url: "https://github.com/acme/mcp-server" },
      { name: "mcp-py", html_url: "https://github.com/acme/mcp-py" },
      { name: "openapi", html_url: "https://github.com/acme/openapi" },
      { name: "sdk-js", html_url: "https://github.com/acme/sdk-js" },
      { name: "sdk-py", html_url: "https://github.com/acme/sdk-py" },
    ];
    const r = await runInit({
      domain: baseUrl,
      github: "acme",
      out: ctx.dir,
      timeoutMs: 2000,
      githubLister: ghLister,
    });
    const parsed = parseYaml(
      readFileSync(r.configPath, "utf8"),
    ) as SkillshipConfig;
    expect(parsed.sources.length).toBeGreaterThanOrEqual(10);
    expect(parsed.coverage).toBe("gold");
  });
});
