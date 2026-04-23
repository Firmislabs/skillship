import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractOpenrefSdk } from "../../src/extractors/openrefSdk.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/openref-sdk/supa-js.yaml"),
);

function fakeSource(): SourceNode {
  return {
    id: "src-sdk",
    kind: "source",
    surface: "sdk",
    url: "https://github.com/supabase/supabase-js/raw/spec.yaml",
    content_type: "application/yaml",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-sdk.yaml",
  };
}

describe("extractOpenrefSdk", () => {
  test("creates one SDK surface parented to the product", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const surfaces = result.nodes.filter((n) => n.kind === "surface");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.parent_id).toBe("product-supa");
  });

  test("emits one operation per inlined function, skipping bare $refs", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(3);
  });

  test("method='sdk' and path_or_name uses function title", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const names = result.claims
      .filter((c) => c.field === "path_or_name")
      .map((c) => c.value)
      .sort();
    expect(names).toEqual(["builder.select()", "supa.from()", "supa.rpc()"]);
    const methods = new Set(
      result.claims.filter((c) => c.field === "method").map((c) => c.value),
    );
    expect(methods).toEqual(new Set(["sdk"]));
  });

  test("emits parameter nodes with type + required + description", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const params = result.nodes.filter((n) => n.kind === "parameter");
    expect(params.length).toBe(4);
    const tableParam = params.find((p) => {
      const nameClaim = result.claims.find(
        (c) => c.node_id === p.id && c.field === "name",
      );
      return nameClaim?.value === "table";
    });
    expect(tableParam).toBeDefined();
    const typeClaim = result.claims.find(
      (c) => c.node_id === tableParam!.id && c.field === "type",
    );
    expect(typeClaim?.value).toBe("string");
    const requiredClaim = result.claims.find(
      (c) => c.node_id === tableParam!.id && c.field === "required",
    );
    expect(requiredClaim?.value).toBe(true);
  });

  test("emits example nodes with language from info.language", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const examples = result.nodes.filter((n) => n.kind === "example");
    expect(examples.length).toBe(1);
    const langClaim = result.claims.find(
      (c) => c.node_id === examples[0]!.id && c.field === "language",
    );
    expect(langClaim?.value).toBe("js");
    const codeClaim = result.claims.find(
      (c) => c.node_id === examples[0]!.id && c.field === "code",
    );
    expect(typeof codeClaim?.value).toBe("string");
    expect((codeClaim!.value as string).includes("supa.from")).toBe(true);
  });

  test("emits illustrated_by edge from operation to example", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const edges = result.edges.filter((e) => e.kind === "illustrated_by");
    expect(edges.length).toBe(1);
  });

  test("stamps extractor openref-sdk@1 and confidence attested", () => {
    const result = extractOpenrefSdk({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    expect(result.extractor).toBe("openref-sdk@1");
    for (const claim of result.claims) {
      expect(claim.confidence).toBe("attested");
      expect(typeof claim.span_path).toBe("string");
    }
  });
});
