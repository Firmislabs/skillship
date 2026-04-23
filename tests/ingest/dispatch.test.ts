import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dispatchExtractor } from "../../src/ingest/dispatch.js";
import type { SourceNode } from "../../src/graph/types.js";

function fakeSource(url: string, contentType: string, id = "s-1"): SourceNode {
  return {
    id,
    kind: "source",
    surface: "docs",
    url,
    content_type: contentType,
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: 0,
    cache_path: "/tmp/nope",
  };
}

describe("dispatchExtractor", () => {
  test("openapi yaml → rest extraction with surface + operations", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://x.example/openapi.yaml",
        "application/openapi+yaml",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("openapi@3");
    expect(res?.nodes.some((n) => n.kind === "surface")).toBe(true);
    expect(res?.nodes.some((n) => n.kind === "operation")).toBe(true);
  });

  test("swagger json → swagger extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/swagger2/gotrue-like.json"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://x.example/swagger.json",
        "application/swagger+json",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("swagger@2");
  });

  test("openref-cli yaml → cli extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/openref-cli/supa-cli.yaml"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://github.com/supa/cli/blob/HEAD/cli.yaml",
        "application/x-openref-cli+yaml",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("openref-cli@1");
  });

  test("openref-sdk yaml → sdk extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/openref-sdk/supa-js.yaml"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://github.com/supa/js/blob/HEAD/openref.yaml",
        "application/x-openref-sdk+yaml",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("openref-sdk@1");
  });

  test("sitemap xml → sitemap extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/sitemap/urlset.xml"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource("https://x.example/sitemap.xml", "application/xml"),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("sitemap@1");
  });

  test("llms.txt by URL suffix → llms-txt extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/llms-txt/supa.txt"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://x.example/llms.txt",
        "text/plain; charset=utf-8",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("llms-txt@1");
  });

  test("mcp well-known by URL path → mcp-well-known extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/mcp-well-known/sample.json"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://mcp.x.example/.well-known/oauth-protected-resource/mcp",
        "application/json; charset=utf-8",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("mcp-well-known@1");
  });

  test("zod-ast TypeScript file → zod-ast extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/zod-ast/mcp-tools.ts"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource(
        "https://github.com/x/mcp/blob/HEAD/mcp-tools.ts",
        "application/typescript",
      ),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("zod-ast@1");
  });

  test("text/markdown not llms.txt → docs-md extraction", async () => {
    const bytes = readFileSync(
      join(process.cwd(), "tests/fixtures/docs-md/guide-auth.md"),
    );
    const res = await dispatchExtractor({
      bytes,
      source: fakeSource("https://x.example/docs/guides/auth", "text/markdown"),
      productId: "p-x",
    });
    expect(res?.extractor).toBe("docs-md@1");
  });

  test("unresolved github.repo placeholder → null", async () => {
    const res = await dispatchExtractor({
      bytes: Buffer.from(""),
      source: fakeSource(
        "https://github.com/x/repo",
        "application/vnd.github.repo",
      ),
      productId: "p-x",
    });
    expect(res).toBeNull();
  });

  test("unknown content type → null", async () => {
    const res = await dispatchExtractor({
      bytes: Buffer.from("irrelevant"),
      source: fakeSource("https://x.example/foo", "image/png"),
      productId: "p-x",
    });
    expect(res).toBeNull();
  });
});
