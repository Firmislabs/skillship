import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractLlmsTxt } from "../../src/extractors/llmsTxt.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/llms-txt/supa.txt"),
);

function fakeSource(): SourceNode {
  return {
    id: "src-llms",
    kind: "source",
    surface: "llms_txt",
    url: "https://supa.example/llms.txt",
    content_type: "text/plain",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-llms.txt",
  };
}

describe("extractLlmsTxt", () => {
  test("emits one DocPage per link across H2 sections", async () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const pages = result.nodes.filter((n) => n.kind === "doc_page");
    expect(pages).toHaveLength(5);
  });

  test("DocPages parented to productId", async () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    for (const n of result.nodes) {
      expect(n.parent_id).toBe("product-supa");
    }
  });

  test("tier is 'optional' for Optional section, 'core' otherwise", () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const tierByUrl = new Map<string, string>();
    const urlByNode = new Map<string, string>();
    for (const c of result.claims) {
      if (c.field === "url") urlByNode.set(c.node_id, String(c.value));
    }
    for (const c of result.claims) {
      if (c.field === "tier") {
        const url = urlByNode.get(c.node_id);
        if (url !== undefined) tierByUrl.set(url, String(c.value));
      }
    }
    expect(tierByUrl.get("https://supa.example/advanced")).toBe("optional");
    expect(tierByUrl.get("https://supa.example/migration")).toBe("optional");
    expect(tierByUrl.get("https://supa.example/docs/getting-started")).toBe(
      "core",
    );
    expect(tierByUrl.get("https://supa.example/examples/basic")).toBe("core");
  });

  test("category claim equals H2 heading verbatim", () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const categories = result.claims
      .filter((c) => c.field === "category")
      .map((c) => String(c.value))
      .sort();
    expect(categories).toContain("Docs");
    expect(categories).toContain("Examples");
    expect(categories).toContain("Optional");
  });

  test("url + title claims present for every DocPage and attested", () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const pageIds = result.nodes
      .filter((n) => n.kind === "doc_page")
      .map((n) => n.id);
    for (const id of pageIds) {
      const url = result.claims.find(
        (c) => c.node_id === id && c.field === "url",
      );
      const title = result.claims.find(
        (c) => c.node_id === id && c.field === "title",
      );
      expect(url).toBeDefined();
      expect(title).toBeDefined();
      expect(url?.confidence).toBe("attested");
      expect(title?.confidence).toBe("attested");
    }
  });

  test("stamps extractor llms-txt@1 with span_path on every claim", () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    expect(result.extractor).toBe("llms-txt@1");
    for (const c of result.claims) {
      expect(typeof c.span_path).toBe("string");
      expect(["attested", "derived"]).toContain(c.confidence);
    }
  });

  test("skips non-link bullets in H2 sections", () => {
    const result = extractLlmsTxt({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const titles = result.claims
      .filter((c) => c.field === "title")
      .map((c) => String(c.value));
    expect(titles).not.toContain("plain text note, skip me");
  });
});
