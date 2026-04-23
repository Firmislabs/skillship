import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildProbeTargets,
  crawlDomain,
  normalizeBase,
} from "../../src/discovery/crawler.js";
import {
  startTestServer,
  type RouteMap,
  type TestServer,
} from "../helpers-http.js";

describe("normalizeBase", () => {
  it("adds https:// when scheme is missing", () => {
    expect(normalizeBase("supabase.com").toString()).toBe(
      "https://supabase.com/",
    );
  });
  it("preserves http for localhost URLs", () => {
    expect(normalizeBase("http://127.0.0.1:9999").toString()).toBe(
      "http://127.0.0.1:9999/",
    );
  });
});

describe("buildProbeTargets", () => {
  it("emits llms.txt, sitemap, OpenAPI guesses, + mcp subdomain for real hosts", () => {
    const targets = buildProbeTargets(normalizeBase("supabase.com"));
    const urls = targets.map((t) => t.url);
    expect(urls).toContain("https://supabase.com/llms.txt");
    expect(urls).toContain("https://supabase.com/sitemap.xml");
    expect(urls).toContain("https://supabase.com/docs/sitemap.xml");
    expect(urls).toContain("https://supabase.com/api/openapi.json");
    expect(urls).toContain("https://supabase.com/api/v1/openapi.json");
    expect(urls).toContain("https://supabase.com/openapi.json");
    expect(urls).toContain("https://supabase.com/swagger.json");
    expect(urls).toContain(
      "https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("includes runtime-generated OpenAPI probe paths", () => {
    const targets = buildProbeTargets(normalizeBase("posthog.com"));
    const urls = targets.map((t) => t.url);
    expect(urls).toContain("https://posthog.com/api/schema/");
    expect(urls).toContain("https://posthog.com/swagger.v1.json");
    expect(urls).toContain("https://posthog.com/v3/api-docs");
  });

  it("probes common api sub-hosts (app.*, api.*) for REST specs", () => {
    const targets = buildProbeTargets(normalizeBase("posthog.com"));
    const urls = targets.map((t) => t.url);
    expect(urls).toContain("https://app.posthog.com/api/schema/");
    expect(urls).toContain("https://api.posthog.com/openapi.json");
  });

  it("skips sub-host probes for IP/localhost", () => {
    const targets = buildProbeTargets(
      normalizeBase("http://127.0.0.1:9999"),
    );
    const urls = targets.map((t) => t.url);
    expect(urls.every((u) => !u.includes("app.127.0.0.1"))).toBe(true);
    expect(urls.every((u) => !u.includes("api.127.0.0.1"))).toBe(true);
  });

  it("omits the mcp subdomain probe for localhost/IP hosts", () => {
    const targets = buildProbeTargets(
      normalizeBase("http://127.0.0.1:9999"),
    );
    const urls = targets.map((t) => t.url);
    expect(urls.every((u) => !u.includes("mcp.127.0.0.1"))).toBe(true);
    expect(urls.every((u) => !u.includes("mcp.localhost"))).toBe(true);
  });
});

describe("crawlDomain (offline)", () => {
  let server: TestServer | null = null;

  beforeEach(() => {
    server = null;
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  async function start(routes: RouteMap): Promise<string> {
    server = await startTestServer(routes);
    return server.url;
  }

  it("returns only probes whose response validates + was 200", async () => {
    const baseUrl = await start({
      "/llms.txt": {
        status: 200,
        contentType: "text/plain",
        body: "# Supabase docs\n\n- [REST](/rest)\n",
      },
      "/sitemap.xml": {
        status: 200,
        contentType: "application/xml",
        body: '<?xml version="1.0"?><urlset></urlset>',
      },
      "/api/openapi.json": {
        status: 200,
        contentType: "application/json",
        body: '{"openapi":"3.0.0"}',
      },
    });
    const results = await crawlDomain(baseUrl, { timeoutMs: 2000 });
    const surfaces = results.map((r) => r.surface).sort();
    const urls = results.map((r) => r.url).sort();
    expect(surfaces).toEqual(["docs", "llms_txt", "rest"]);
    expect(urls).toEqual([
      `${baseUrl}/api/openapi.json`,
      `${baseUrl}/llms.txt`,
      `${baseUrl}/sitemap.xml`,
    ]);
  });

  it("rejects llms.txt that is actually HTML (Segment-style)", async () => {
    const baseUrl = await start({
      "/llms.txt": {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: "<!DOCTYPE html><html>...</html>",
      },
    });
    const results = await crawlDomain(baseUrl, { timeoutMs: 2000 });
    const llmsHit = results.find((r) => r.surface === "llms_txt");
    expect(llmsHit).toBeUndefined();
  });

  it("skips probes that return 404", async () => {
    const baseUrl = await start({
      "/llms.txt": {
        status: 200,
        contentType: "text/plain",
        body: "# Only one real signal",
      },
    });
    const results = await crawlDomain(baseUrl, { timeoutMs: 2000 });
    expect(results).toHaveLength(1);
    expect(results[0]?.surface).toBe("llms_txt");
  });

  it("returns empty array when nothing hits", async () => {
    const baseUrl = await start({});
    const results = await crawlDomain(baseUrl, { timeoutMs: 2000 });
    expect(results).toEqual([]);
  });
});
