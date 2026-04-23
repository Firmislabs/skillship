import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractDocsMd } from "../../src/extractors/docsMd.js";
import type { SourceNode } from "../../src/graph/types.js";

const GUIDE = readFileSync(
  join(process.cwd(), "tests/fixtures/docs-md/guide-auth.md"),
);
const NO_H1 = readFileSync(
  join(process.cwd(), "tests/fixtures/docs-md/no-h1.md"),
);

function fakeSource(url: string, contentType: string): SourceNode {
  return {
    id: `src-${Buffer.from(url).toString("base64").slice(0, 8)}`,
    kind: "source",
    surface: "docs",
    url,
    content_type: contentType,
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: 0,
    cache_path: "/tmp/src-md.md",
  };
}

describe("extractDocsMd", () => {
  test("happy path: emits exactly one doc_page for markdown with H1", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "text/markdown",
      ),
      productId: "product-supa",
    });
    const pages = result.nodes.filter((n) => n.kind === "doc_page");
    expect(pages).toHaveLength(1);
    expect(pages[0]?.parent_id).toBe("product-supa");
  });

  test("title from H1 is attested and equals 'Auth Guide'", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "text/markdown",
      ),
      productId: "product-supa",
    });
    const title = result.claims.find((c) => c.field === "title");
    expect(title?.value).toBe("Auth Guide");
    expect(title?.confidence).toBe("attested");
  });

  test("title falls back to URL slug, derived, when no H1 present", () => {
    const result = extractDocsMd({
      bytes: NO_H1,
      source: fakeSource(
        "https://supa.example/docs/reference/select",
        "text/markdown",
      ),
      productId: "product-supa",
    });
    const title = result.claims.find((c) => c.field === "title");
    expect(title?.value).toBe("select");
    expect(title?.confidence).toBe("derived");
  });

  test("content_hash is sha256 of bytes, attested", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "text/markdown",
      ),
      productId: "product-supa",
    });
    const expected = createHash("sha256").update(GUIDE).digest("hex");
    const ch = result.claims.find((c) => c.field === "content_hash");
    expect(ch?.value).toBe(expected);
    expect(ch?.confidence).toBe("attested");
  });

  test("category derived from URL path (drops last segment)", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "text/markdown",
      ),
      productId: "product-supa",
    });
    const cat = result.claims.find((c) => c.field === "category");
    expect(cat?.value).toBe("docs/guides");
    expect(cat?.confidence).toBe("derived");
  });

  test("non-markdown content_type returns empty extraction (with stamp)", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "application/json",
      ),
      productId: "product-supa",
    });
    expect(result.extractor).toBe("docs-md@1");
    expect(result.nodes).toEqual([]);
    expect(result.claims).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test("text/markdown; charset=utf-8 is accepted", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "text/markdown; charset=utf-8",
      ),
      productId: "product-supa",
    });
    expect(result.nodes.filter((n) => n.kind === "doc_page")).toHaveLength(1);
  });

  test("every claim has span_path + valid confidence", () => {
    const result = extractDocsMd({
      bytes: GUIDE,
      source: fakeSource(
        "https://supa.example/docs/guides/auth",
        "text/markdown",
      ),
      productId: "product-supa",
    });
    expect(result.extractor).toBe("docs-md@1");
    for (const c of result.claims) {
      expect(typeof c.span_path).toBe("string");
      expect(["attested", "derived"]).toContain(c.confidence);
    }
  });
});
