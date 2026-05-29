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
});
