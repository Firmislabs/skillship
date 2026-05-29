import { describe, expect, test } from "vitest";
import { camelToSnake, buildFernOas } from "../../src/renderers/fern-oas-rewrite.js";
import { extractOperations } from "../../src/renderers/sdk-utils.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

describe("camelToSnake", () => {
  test.each([
    ["getAttachments", "get_attachments"],
    ["apiKeys", "api_keys"],
    ["list", "list"],
    ["getURL", "get_url"],
    ["_2fa", "_2fa"],
  ])("%s -> %s", (input, expected) => {
    expect(camelToSnake(input)).toBe(expected);
  });
});

describe("buildFernOas", () => {
  const oas = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/emails": {
        get: { operationId: "op_aaa", tags: ["emails"] },
        post: { operationId: "op_bbb", tags: ["emails"] },
      },
    },
  });

  test("rewrites operationId=snake(ns)_snake(method) and tags=[ns]; input unchanged", () => {
    const ops = extractOperations(oas);
    const out = buildFernOas(oas, ops, CodegenOverlaySchema.parse({}));
    const doc = JSON.parse(out);
    expect(doc.paths["/emails"].get.operationId).toBe("emails_list");
    expect(doc.paths["/emails"].get.tags).toEqual(["emails"]);
    expect(doc.paths["/emails"].post.operationId).toBe("emails_create");
    // input string not mutated
    expect(JSON.parse(oas).paths["/emails"].get.operationId).toBe("op_aaa");
  });

  test("passes through operations absent from the ops list without rewriting them", () => {
    // OAS doc with two operations: one normal and one orphan.
    const oasWithOrphan = JSON.stringify({
      openapi: "3.1.0",
      paths: {
        "/emails": {
          get: { operationId: "op_aaa", tags: ["emails"] },
        },
        "/orphan": {
          get: { operationId: "op_orphan_xyz" },
        },
      },
    });

    // Extract all ops, then exclude the orphan so it is present in the doc
    // but NOT in the assignment map — this is exactly the condition that triggers
    // `if (!hit) continue` in buildFernOas.
    const allOps = extractOperations(oasWithOrphan);
    const opsSubset = allOps.filter((o) => o.operationId !== "op_orphan_xyz");

    const out = buildFernOas(oasWithOrphan, opsSubset, CodegenOverlaySchema.parse({}));
    const doc = JSON.parse(out);

    // The normal op was in opsSubset → it MUST be rewritten.
    expect(doc.paths["/emails"].get.operationId).toBe("emails_list");

    // The orphan was NOT in opsSubset → it MUST be left untouched.
    expect(doc.paths["/orphan"].get.operationId).toBe("op_orphan_xyz");
    // tags should remain absent (undefined) since we never set them.
    expect(doc.paths["/orphan"].get.tags).toBeUndefined();
  });
});
