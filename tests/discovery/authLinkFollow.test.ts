import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  filterAuthDocUrls,
  fetchAuthDocPages,
  fetchUrlsAsDocPages,
  type AuthDocFetchInput,
} from "../../src/discovery/authLinkFollow.js";
import {
  startTestServer,
  type RouteMap,
  type TestServer,
} from "../helpers-http.js";

describe("filterAuthDocUrls", () => {
  it("includes URLs whose category is Authentication", () => {
    const pages = [
      { url: "https://linear.app/developers/oauth-2-0-authentication.md", category: "Authentication", title: "OAuth 2.0" },
      { url: "https://linear.app/developers/getting-started.md", category: "Docs", title: "Getting Started" },
    ];
    const result = filterAuthDocUrls(pages);
    expect(result).toContain("https://linear.app/developers/oauth-2-0-authentication.md");
    expect(result).not.toContain("https://linear.app/developers/getting-started.md");
  });

  it("includes URLs whose title matches auth keywords", () => {
    const pages = [
      { url: "https://api.example.com/docs/api-key.md", category: "Docs", title: "API Key Guide" },
      { url: "https://api.example.com/docs/webhooks.md", category: "Docs", title: "Webhooks" },
    ];
    const result = filterAuthDocUrls(pages);
    expect(result).toContain("https://api.example.com/docs/api-key.md");
    expect(result).not.toContain("https://api.example.com/docs/webhooks.md");
  });

  it("skips URLs that are not HTTPS", () => {
    const pages = [
      { url: "http://example.com/auth.md", category: "Authentication", title: "Auth" },
    ];
    const result = filterAuthDocUrls(pages);
    expect(result).toHaveLength(0);
  });

  it("skips URLs that do not end in .md", () => {
    const pages = [
      { url: "https://example.com/docs/auth", category: "Authentication", title: "Auth" },
      { url: "https://example.com/docs/oauth.html", category: "Authentication", title: "OAuth" },
    ];
    const result = filterAuthDocUrls(pages);
    expect(result).toHaveLength(0);
  });

  it("caps results at 5", () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/docs/auth-${i}.md`,
      category: "Authentication",
      title: `Auth ${i}`,
    }));
    const result = filterAuthDocUrls(pages);
    expect(result).toHaveLength(5);
  });
});

describe("fetchAuthDocPages", () => {
  let server: TestServer | null = null;

  beforeEach(() => {
    server = null;
  });

  afterEach(async () => {
    if (server !== null) await server.close();
  });

  async function start(routes: RouteMap): Promise<string> {
    server = await startTestServer(routes);
    return server.url;
  }

  it("fetches matching .md URLs and returns CrawlResult entries", async () => {
    // fetchUrlsAsDocPages accepts any URL (HTTPS filter is in filterAuthDocUrls);
    // here we use the local http test server directly.
    const baseUrl = await start({
      "/docs/oauth.md": {
        status: 200,
        contentType: "text/markdown",
        body: "# OAuth\n\n## Authentication\n\nbearer token",
      },
    });
    const urls = [`${baseUrl}/docs/oauth.md`];
    const results = await fetchUrlsAsDocPages(urls, 2000);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe(`${baseUrl}/docs/oauth.md`);
    expect(results[0]?.content_type).toMatch(/text\/markdown/);
    expect(results[0]?.surface).toBe("docs");
  });

  it("skips non-.md URLs in fetchUrlsAsDocPages", async () => {
    const baseUrl = await start({
      "/docs/auth": { status: 200, contentType: "text/html", body: "<html>" },
    });
    const urls = [`${baseUrl}/docs/auth`];
    const results = await fetchUrlsAsDocPages(urls, 2000);
    expect(results).toHaveLength(0);
  });

  it("fetchAuthDocPages skips non-HTTPS URLs from pages list", async () => {
    // Non-HTTPS pages are filtered out by filterAuthDocUrls before fetch.
    const pages: AuthDocFetchInput["pages"] = [
      { url: "http://example.com/auth.md", category: "Authentication", title: "Auth" },
    ];
    const results = await fetchAuthDocPages({ pages, timeoutMs: 2000 });
    expect(results).toHaveLength(0);
  });

  it("caps fetches at 5 even when more URLs are eligible", async () => {
    const routes: RouteMap = {};
    const urls = Array.from({ length: 8 }, (_, i) => {
      const path = `/docs/auth-${i}.md`;
      routes[path] = {
        status: 200,
        contentType: "text/markdown",
        body: `# Auth ${i}\n\n## Authentication\n\nbearer token`,
      };
      return `PLACEHOLDER${path}`;
    });

    const baseUrl = await start(routes);
    const realUrls = urls.map(u => u.replace("PLACEHOLDER", baseUrl));
    const results = await fetchUrlsAsDocPages(realUrls, 2000);
    expect(results.length).toBeLessThanOrEqual(5);
  });
});
