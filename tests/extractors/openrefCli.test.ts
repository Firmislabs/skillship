import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractOpenrefCli } from "../../src/extractors/openrefCli.js";
import type { SourceNode } from "../../src/graph/types.js";

const FIXTURE = readFileSync(
  join(process.cwd(), "tests/fixtures/openref-cli/supa-cli.yaml"),
);

function fakeSource(overrides: Partial<SourceNode> = {}): SourceNode {
  return {
    id: "src-cli",
    kind: "source",
    surface: "cli",
    url: "https://github.com/supabase/cli/raw/spec.yaml",
    content_type: "application/yaml",
    fetched_at: "2026-04-23T00:00:00Z",
    bytes: FIXTURE.length,
    cache_path: "/tmp/src-cli.yaml",
    ...overrides,
  };
}

describe("extractOpenrefCli", () => {
  test("creates one CLI surface node parented to the product", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const surfaces = result.nodes.filter((n) => n.kind === "surface");
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0]!.parent_id).toBe("product-supa");
    const versionClaim = result.claims.find(
      (c) => c.node_id === surfaces[0]!.id && c.field === "version",
    );
    expect(versionClaim?.value).toBe("2.0.0");
  });

  test("emits an operation for every command and subcommand", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const ops = result.nodes.filter((n) => n.kind === "operation");
    expect(ops).toHaveLength(4);
  });

  test("uses the joined command path as path_or_name and 'cli' as method", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const names = result.claims
      .filter((c) => c.field === "path_or_name")
      .map((c) => c.value)
      .sort();
    expect(names).toEqual(["db", "db diff", "db reset", "init"]);
    const methods = new Set(
      result.claims.filter((c) => c.field === "method").map((c) => c.value),
    );
    expect(methods).toEqual(new Set(["cli"]));
  });

  test("emits parameter nodes for each flag with location=flag", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const params = result.nodes.filter((n) => n.kind === "parameter");
    expect(params.length).toBe(4);
    for (const p of params) {
      const locClaim = result.claims.find(
        (c) => c.node_id === p.id && c.field === "location",
      );
      expect(locClaim?.value).toBe("flag");
    }
  });

  test("captures flag required + type + default", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const forceReq = claimValue(result, "force", "required", "init");
    expect(forceReq).toBe(false);
    const forceType = claimValue(result, "force", "type", "init");
    expect(forceType).toBe("boolean");
    const forceDefault = claimValue(result, "force", "default", "init");
    expect(forceDefault).toBe("false");
    const schemaReq = claimValue(result, "schema", "required", "db diff");
    expect(schemaReq).toBe(true);
  });

  test("emits has_operation and has_parameter edges", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource(),
      productId: "product-supa",
    });
    const hasOps = result.edges.filter((e) => e.kind === "has_operation");
    expect(hasOps).toHaveLength(4);
    const hasParams = result.edges.filter((e) => e.kind === "has_parameter");
    expect(hasParams).toHaveLength(4);
  });

  test("stamps extractor openref-cli@1 and confidence attested", () => {
    const result = extractOpenrefCli({
      bytes: FIXTURE,
      source: fakeSource({ id: "sourcecli" }),
      productId: "product-supa",
    });
    expect(result.extractor).toBe("openref-cli@1");
    expect(result.source_id).toBe("sourcecli");
    for (const claim of result.claims) {
      expect(claim.confidence).toBe("attested");
      expect(typeof claim.span_path).toBe("string");
    }
  });
});

function claimValue(
  result: { claims: { node_id: string; field: string; value: unknown }[] },
  flagName: string,
  field: string,
  parentCommand: string,
): unknown {
  const nameClaim = result.claims.find(
    (c) => c.field === "name" && c.value === flagName,
  );
  if (!nameClaim) return undefined;
  const paramId = nameClaim.node_id;
  return result.claims.find(
    (c) => c.node_id === paramId && c.field === field,
  )?.value;
  void parentCommand;
}
