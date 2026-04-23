import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { bundleOpenapiRefs } from "../../src/resolvers/openapiBundle.js";

function yamlDoc(obj: unknown): Buffer {
  return Buffer.from(
    `${JSON.stringify(obj)}\n`,
    "utf8",
  );
}

function asDoc(bytes: Buffer): unknown {
  return parseYaml(bytes.toString("utf8")) as unknown;
}

function makeGetBlob(
  files: Record<string, unknown>,
): (path: string) => Promise<Buffer | null> {
  return async (path) => {
    const f = files[path];
    if (f === undefined) return null;
    return Buffer.from(JSON.stringify(f), "utf8");
  };
}

describe("bundleOpenapiRefs", () => {
  test("inlines single path-level ref", async () => {
    const root = yamlDoc({
      openapi: "3.0.0",
      paths: { "/users": { $ref: "./paths/users.yaml" } },
    });
    const getBlob = makeGetBlob({
      "paths/users.yaml": { get: { summary: "list users" } },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", getBlob);
    expect(asDoc(out)).toEqual({
      openapi: "3.0.0",
      paths: { "/users": { get: { summary: "list users" } } },
    });
  });

  test("resolves paths relative to root's directory", async () => {
    const root = yamlDoc({
      paths: { "/u": { $ref: "./p/u.yaml" } },
    });
    const getBlob = makeGetBlob({
      "apps/api/p/u.yaml": { get: { summary: "ok" } },
    });
    const out = await bundleOpenapiRefs(
      root,
      "apps/api/openapi.yaml",
      getBlob,
    );
    expect(asDoc(out)).toEqual({
      paths: { "/u": { get: { summary: "ok" } } },
    });
  });

  test("handles parent-relative refs", async () => {
    const root = yamlDoc({
      paths: { "/x": { $ref: "../shared/x.yaml" } },
    });
    const getBlob = makeGetBlob({
      "apps/shared/x.yaml": { get: { summary: "x" } },
    });
    const out = await bundleOpenapiRefs(
      root,
      "apps/api/openapi.yaml",
      getBlob,
    );
    expect(asDoc(out)).toEqual({
      paths: { "/x": { get: { summary: "x" } } },
    });
  });

  test("extracts JSON pointer fragment", async () => {
    const root = yamlDoc({
      components: {
        schemas: { User: { $ref: "./c.yaml#/schemas/User" } },
      },
    });
    const getBlob = makeGetBlob({
      "c.yaml": {
        schemas: {
          User: { type: "object", properties: { id: { type: "string" } } },
          Other: { type: "string" },
        },
      },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", getBlob);
    expect(asDoc(out)).toEqual({
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "string" } },
          },
        },
      },
    });
  });

  test("resolves transitive refs across files", async () => {
    const root = yamlDoc({
      paths: { "/a": { $ref: "./paths/a.yaml" } },
    });
    const getBlob = makeGetBlob({
      "paths/a.yaml": {
        get: { responses: { "200": { $ref: "../schemas/r.yaml" } } },
      },
      "schemas/r.yaml": { description: "ok" },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", getBlob);
    expect(asDoc(out)).toEqual({
      paths: {
        "/a": {
          get: { responses: { "200": { description: "ok" } } },
        },
      },
    });
  });

  test("preserves internal #/ refs", async () => {
    const root = yamlDoc({
      paths: {
        "/u": { get: { responses: { "200": { $ref: "#/components/x" } } } },
      },
      components: { x: { description: "x" } },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", makeGetBlob({}));
    expect(asDoc(out)).toEqual({
      paths: {
        "/u": { get: { responses: { "200": { $ref: "#/components/x" } } } },
      },
      components: { x: { description: "x" } },
    });
  });

  test("preserves remote http(s) refs", async () => {
    const root = yamlDoc({
      paths: { "/u": { $ref: "https://example.com/spec.yaml" } },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", makeGetBlob({}));
    expect(asDoc(out)).toEqual({
      paths: { "/u": { $ref: "https://example.com/spec.yaml" } },
    });
  });

  test("missing target keeps ref as-is (no crash)", async () => {
    const root = yamlDoc({
      paths: { "/u": { $ref: "./paths/missing.yaml" } },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", makeGetBlob({}));
    expect(asDoc(out)).toEqual({
      paths: { "/u": { $ref: "./paths/missing.yaml" } },
    });
  });

  test("cycle detection: a → b → a stops without infinite loop", async () => {
    const root = yamlDoc({
      a: { $ref: "./a.yaml" },
    });
    const getBlob = makeGetBlob({
      "a.yaml": { inner: { $ref: "./b.yaml" } },
      "b.yaml": { loop: { $ref: "./a.yaml" } },
    });
    const out = await bundleOpenapiRefs(root, "openapi.yaml", getBlob);
    const doc = asDoc(out) as Record<string, unknown>;
    expect(doc).toBeDefined();
  });

  test("JSON spec file (openapi.json)", async () => {
    const root = Buffer.from(
      JSON.stringify({
        openapi: "3.0.0",
        paths: { "/u": { $ref: "./p.json" } },
      }),
      "utf8",
    );
    const getBlob = makeGetBlob({
      "p.json": { get: { summary: "j" } },
    });
    const out = await bundleOpenapiRefs(root, "openapi.json", getBlob);
    const doc = asDoc(out) as { paths: Record<string, unknown> };
    expect(doc.paths["/u"]).toEqual({ get: { summary: "j" } });
  });
});
