import { describe, expect, test } from "vitest";
import { camelToSnake, buildFernOas } from "../../src/renderers/fern-oas-rewrite.js";
import { extractOperations } from "../../src/renderers/sdk-utils.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import type { PaginationPlan } from "../../src/renderers/pagination-detect.js";

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
    const out = buildFernOas(oas, ops, CodegenOverlaySchema.parse({}), new Map());
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

    const out = buildFernOas(oasWithOrphan, opsSubset, CodegenOverlaySchema.parse({}), new Map());
    const doc = JSON.parse(out);

    // The normal op was in opsSubset → it MUST be rewritten.
    expect(doc.paths["/emails"].get.operationId).toBe("emails_list");

    // The orphan was NOT in opsSubset → it MUST be left untouched.
    expect(doc.paths["/orphan"].get.operationId).toBe("op_orphan_xyz");
    // tags should remain absent (undefined) since we never set them.
    expect(doc.paths["/orphan"].get.tags).toBeUndefined();
  });
});

// ---- x-fern-pagination stamping tests ----

describe("buildFernOas — x-fern-pagination stamping", () => {
  const oasPagination = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: {
          operationId: "op_cursor",
          tags: ["items"],
          parameters: [
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
        },
        post: {
          operationId: "op_create",
          tags: ["items"],
        },
      },
      "/logs": {
        get: {
          operationId: "op_offset",
          tags: ["logs"],
          parameters: [
            { name: "offset", in: "query", schema: { type: "integer" } },
          ],
        },
      },
      "/pages": {
        get: {
          operationId: "op_page",
          tags: ["pages"],
          parameters: [
            { name: "page", in: "query", schema: { type: "integer" } },
          ],
        },
      },
    },
  });

  const cursorPlan: PaginationPlan = {
    style: "cursor",
    requestParam: "cursor",
    pageSizeParam: null,
    itemsField: "data",
    nextField: "next_cursor",
  };

  const offsetPlan: PaginationPlan = {
    style: "offset",
    requestParam: "offset",
    pageSizeParam: "limit",
    itemsField: "data",
    nextField: null,
  };

  const pagePlan: PaginationPlan = {
    style: "page",
    requestParam: "page",
    pageSizeParam: "per_page",
    itemsField: "data",
    nextField: null,
  };

  test("cursor plan stamps x-fern-pagination with $request/$response prefixes", () => {
    const plans = new Map<string, PaginationPlan>([["op_cursor", cursorPlan]]);
    const ops = extractOperations(oasPagination);
    const out = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    const doc = JSON.parse(out);

    const stamp = doc.paths["/items"].get["x-fern-pagination"];
    expect(stamp).toBeDefined();
    expect(stamp.cursor).toBe("$request.cursor");
    expect(stamp.next_cursor).toBe("$response.next_cursor");
    expect(stamp.results).toBe("$response.data");
  });

  test("offset plan stamps x-fern-pagination with offset form", () => {
    const plans = new Map<string, PaginationPlan>([["op_offset", offsetPlan]]);
    const ops = extractOperations(oasPagination);
    const out = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    const doc = JSON.parse(out);

    const stamp = doc.paths["/logs"].get["x-fern-pagination"];
    expect(stamp).toBeDefined();
    expect(stamp.offset).toBe("$request.offset");
    expect(stamp.results).toBe("$response.data");
    // cursor/next_cursor must not appear in offset form
    expect(stamp.cursor).toBeUndefined();
    expect(stamp.next_cursor).toBeUndefined();
  });

  test("page style stamps the offset form with the page param", () => {
    const plans = new Map<string, PaginationPlan>([["op_page", pagePlan]]);
    const ops = extractOperations(oasPagination);
    const out = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    const doc = JSON.parse(out);

    const stamp = doc.paths["/pages"].get["x-fern-pagination"];
    expect(stamp).toBeDefined();
    expect(stamp.offset).toBe("$request.page");
    expect(stamp.results).toBe("$response.data");
  });

  test("unplanned ops are byte-unchanged (no x-fern-pagination key)", () => {
    const plans = new Map<string, PaginationPlan>([["op_cursor", cursorPlan]]);
    const ops = extractOperations(oasPagination);
    const out = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    const doc = JSON.parse(out);

    // POST /items has no plan
    expect(doc.paths["/items"].post["x-fern-pagination"]).toBeUndefined();
    // GET /logs has no plan
    expect(doc.paths["/logs"].get["x-fern-pagination"]).toBeUndefined();
  });

  test("empty plans map: no ops get x-fern-pagination stamps", () => {
    const ops = extractOperations(oasPagination);
    const out = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), new Map());
    const doc = JSON.parse(out);

    expect(doc.paths["/items"].get["x-fern-pagination"]).toBeUndefined();
    expect(doc.paths["/logs"].get["x-fern-pagination"]).toBeUndefined();
  });

  // Fix 3(b): cursor plan with null nextField must NOT emit any stamp (not silently
  // fall through to the offset form).
  test("cursor plan with null nextField emits no x-fern-pagination stamp", () => {
    const cursorNullNext: PaginationPlan = {
      style: "cursor",
      requestParam: "cursor",
      pageSizeParam: null,
      itemsField: "data",
      nextField: null,
    };
    const plans = new Map<string, PaginationPlan>([["op_cursor", cursorNullNext]]);
    const ops = extractOperations(oasPagination);
    const out = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    const doc = JSON.parse(out);

    // Must be absent — emitting the offset form for a cursor plan without nextField
    // would silently produce an incorrect Fern config.
    expect(doc.paths["/items"].get["x-fern-pagination"]).toBeUndefined();
  });

  // Fix 3(d): two calls with identical inputs must produce byte-identical output
  // (determinism test — replaces vacuous string-equality check).
  test("two calls with the same inputs produce byte-identical output (determinism)", () => {
    const plans = new Map<string, PaginationPlan>([["op_cursor", cursorPlan]]);
    const ops = extractOperations(oasPagination);
    const out1 = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    const out2 = buildFernOas(oasPagination, ops, CodegenOverlaySchema.parse({}), plans);
    expect(out1).toBe(out2);
    // Input is not mutated: the original string still parses without x-fern-pagination.
    expect(JSON.parse(oasPagination).paths["/items"].get["x-fern-pagination"]).toBeUndefined();
  });
});

// ---- x-skillship-annotations strip tests (Task 1) ----

describe("buildFernOas — x-skillship-annotations stripping", () => {
  const oasWithAnnotations = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/items": {
        get: {
          operationId: "op_list",
          tags: ["items"],
          "x-skillship-annotations": { destructive: false, readOnly: true },
        },
        post: {
          operationId: "op_create",
          tags: ["items"],
          "x-skillship-annotations": { destructive: true },
        },
      },
      "/logs": {
        get: {
          operationId: "op_logs",
          tags: ["logs"],
          // no x-skillship-annotations — must remain untouched (no key added)
        },
      },
    },
  });

  test("x-skillship-annotations is absent from all operations in Fern output", () => {
    const ops = extractOperations(oasWithAnnotations);
    const out = buildFernOas(oasWithAnnotations, ops, CodegenOverlaySchema.parse({}), new Map());
    const doc = JSON.parse(out);

    expect(doc.paths["/items"].get["x-skillship-annotations"]).toBeUndefined();
    expect(doc.paths["/items"].post["x-skillship-annotations"]).toBeUndefined();
    expect(doc.paths["/logs"].get["x-skillship-annotations"]).toBeUndefined();
  });

  test("stripping does not affect other extension keys (x-fern-pagination survives)", () => {
    const cursorPlan: PaginationPlan = {
      style: "cursor",
      requestParam: "cursor",
      pageSizeParam: null,
      itemsField: "data",
      nextField: "next_cursor",
    };
    const ops = extractOperations(oasWithAnnotations);
    const plans = new Map<string, PaginationPlan>([["op_list", cursorPlan]]);
    const out = buildFernOas(oasWithAnnotations, ops, CodegenOverlaySchema.parse({}), plans);
    const doc = JSON.parse(out);

    // x-fern-pagination should be stamped by the plan
    expect(doc.paths["/items"].get["x-fern-pagination"]).toBeDefined();
    // x-skillship-annotations must still be gone
    expect(doc.paths["/items"].get["x-skillship-annotations"]).toBeUndefined();
  });

  test("input OAS string is not mutated (annotations still present in original)", () => {
    const ops = extractOperations(oasWithAnnotations);
    buildFernOas(oasWithAnnotations, ops, CodegenOverlaySchema.parse({}), new Map());
    // Original must still have the annotations
    const original = JSON.parse(oasWithAnnotations);
    expect(original.paths["/items"].get["x-skillship-annotations"]).toBeDefined();
    expect(original.paths["/items"].post["x-skillship-annotations"]).toBeDefined();
  });

  test("op without annotations in input has no x-skillship-annotations in output", () => {
    const ops = extractOperations(oasWithAnnotations);
    const out = buildFernOas(oasWithAnnotations, ops, CodegenOverlaySchema.parse({}), new Map());
    const doc = JSON.parse(out);
    expect(doc.paths["/logs"].get["x-skillship-annotations"]).toBeUndefined();
  });
});
