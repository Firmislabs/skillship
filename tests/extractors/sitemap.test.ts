import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractSitemap } from "../../src/extractors/sitemap.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/sitemap/urlset.xml"),
);

function fakeSource(): SourceNode {
  return {
    id: "src-sitemap",
    kind: "source",
    surface: "docs",
    url: "https://supa.example/sitemap.xml",
    content_type: "application/xml",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-sitemap.xml",
  };
}

describe("extractSitemap", () => {
  test("emits one DocPage node per <url> entry", async () => {
    const result = await extractSitemap({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const pages = result.nodes.filter((n) => n.kind === "doc_page");
    expect(pages).toHaveLength(3);
  });

  test("DocPages parented to product", async () => {
    const result = await extractSitemap({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const pages = result.nodes.filter((n) => n.kind === "doc_page");
    for (const p of pages) {
      expect(p.parent_id).toBe("product-supa");
    }
  });

  test("captures url + last_modified claims", async () => {
    const result = await extractSitemap({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const urls = result.claims
      .filter((c) => c.field === "url")
      .map((c) => c.value)
      .sort();
    expect(urls).toEqual([
      "https://supa.example/docs/guides/auth",
      "https://supa.example/docs/guides/getting-started",
      "https://supa.example/docs/reference/js/select",
    ]);
    const lastmods = result.claims
      .filter((c) => c.field === "last_modified")
      .map((c) => c.value)
      .sort();
    expect(lastmods).toEqual(["2024-10-01", "2024-11-15"]);
  });

  test("emits title claim derived from URL last segment", async () => {
    const result = await extractSitemap({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const titles = result.claims
      .filter((c) => c.field === "title")
      .map((c) => c.value)
      .sort();
    expect(titles).toContain("select");
    expect(titles).toContain("getting-started");
  });

  test("returns zero DocPages when root is a sitemap index", async () => {
    const indexXml = Buffer.from(`<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://supa.example/docs/sitemap.xml</loc></sitemap>
</sitemapindex>`);
    const result = await extractSitemap({
      bytes: indexXml,
      source: fakeSource(),
      productId: "product-supa",
    });
    const pages = result.nodes.filter((n) => n.kind === "doc_page");
    expect(pages).toHaveLength(0);
  });

  test("stamps extractor sitemap@1 with attested confidence", async () => {
    const result = await extractSitemap({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    expect(result.extractor).toBe("sitemap@1");
    for (const claim of result.claims) {
      expect(["attested", "derived"]).toContain(claim.confidence);
      expect(typeof claim.span_path).toBe("string");
    }
  });
});
