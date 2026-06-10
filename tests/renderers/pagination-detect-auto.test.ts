// tests/renderers/pagination-detect-auto.test.ts
// Pagination detection: auto-detect tier 3 — cursor, offset, page happy-path + synonym tables.
// Ambiguity guards, conservatism guards, and edge cases live in pagination-detect-guards.test.ts.

import { describe, expect, test } from "vitest";
import { detectPagination } from "../../src/renderers/pagination-detect.js";
import type { OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
import {
  makeGetOas,
  makeOp,
  EMPTY_OVERLAY,
  CURSOR_SCHEMA,
  CURSOR_PARAMS,
  OFFSET_SCHEMA,
  OFFSET_PARAMS,
  PAGE_SCHEMA,
  PAGE_PARAMS,
  type OasParam,
  type OasResponseSchema,
} from "./pagination-detect-helpers.js";

// ============================
// AUTO-DETECT: cursor
// ============================

describe("auto-detect cursor", () => {
  test("standard cursor: next_cursor + cursor param", () => {
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("cursor");
    expect(plan.requestParam).toBe("cursor");
    expect(plan.nextField).toBe("next_cursor");
    expect(plan.itemsField).toBe("data");
    expect(plan.pageSizeParam).toBe("limit");
  });

  test("cursor: no pageSizeParam when limit absent", () => {
    const oasJson = makeGetOas(
      "listItems",
      [{ name: "cursor", in: "query", schema: { type: "string" } }],
      CURSOR_SCHEMA,
    );
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    const plan = result.get("listItems")!;
    expect(plan.pageSizeParam).toBeNull();
  });

  test.each([
    ["nextCursor", "cursor"],
    ["next_page_token", "page_token"],
    ["next_cursor", "starting_after"],
  ])(
    "cursor synonym: responseField=%s, requestParam=%s",
    (responseField, requestParam) => {
      const schema: OasResponseSchema = {
        type: "object",
        properties: {
          data: { type: "array", items: {} },
          [responseField]: { type: "string" },
        },
      };
      const params: OasParam[] = [
        { name: requestParam, in: "query", schema: { type: "string" } },
      ];
      const oasJson = makeGetOas("listItems", params, schema);
      const ops: readonly OperationInfo[] = [makeOp("listItems")];
      const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
      expect(result.has("listItems")).toBe(true);
      const plan = result.get("listItems")!;
      expect(plan.style).toBe("cursor");
      expect(plan.nextField).toBe(responseField);
      expect(plan.requestParam).toBe(requestParam);
    },
  );

  test("cursor: page_size recognized as pageSizeParam synonym", () => {
    const params: OasParam[] = [
      { name: "cursor", in: "query", schema: { type: "string" } },
      { name: "page_size", in: "query", schema: { type: "integer" } },
    ];
    const oasJson = makeGetOas("listItems", params, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    const plan = result.get("listItems")!;
    expect(plan.pageSizeParam).toBe("page_size");
  });

  test("cursor: per_page recognized as pageSizeParam synonym", () => {
    const params: OasParam[] = [
      { name: "cursor", in: "query", schema: { type: "string" } },
      { name: "per_page", in: "query", schema: { type: "integer" } },
    ];
    const oasJson = makeGetOas("listItems", params, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    const plan = result.get("listItems")!;
    expect(plan.pageSizeParam).toBe("per_page");
  });

  test("cursor: object-like schema without type keyword is detected (OAS 3.1 — type:object optional)", () => {
    // OAS 3.1 makes `type: object` optional when `properties` is present.
    // The detection gate must treat propertied schemas as object-like even without explicit type.
    const noTypeSchema: OasResponseSchema = {
      properties: {
        data: { type: "array", items: {} },
        next_cursor: { type: "string" },
      },
      required: ["data"],
    };
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, noTypeSchema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("cursor");
    expect(plan.nextField).toBe("next_cursor");
    expect(plan.itemsField).toBe("data");
  });
});

// ============================
// AUTO-DETECT: offset
// ============================

describe("auto-detect offset", () => {
  test("offset: offset + limit integer params", () => {
    const oasJson = makeGetOas("listItems", OFFSET_PARAMS, OFFSET_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("offset");
    expect(plan.requestParam).toBe("offset");
    expect(plan.nextField).toBeNull();
    expect(plan.itemsField).toBe("data");
    expect(plan.pageSizeParam).toBe("limit");
  });
});

// ============================
// AUTO-DETECT: page
// ============================

describe("auto-detect page", () => {
  test("page: page + per_page integer params", () => {
    const oasJson = makeGetOas("listItems", PAGE_PARAMS, PAGE_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("page");
    expect(plan.requestParam).toBe("page");
    expect(plan.nextField).toBeNull();
    expect(plan.itemsField).toBe("data");
    expect(plan.pageSizeParam).toBe("per_page");
  });

  test("page: page + page_size integer params", () => {
    const params: OasParam[] = [
      { name: "page", in: "query", schema: { type: "integer" } },
      { name: "page_size", in: "query", schema: { type: "integer" } },
    ];
    const oasJson = makeGetOas("listItems", params, PAGE_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("page");
    expect(plan.pageSizeParam).toBe("page_size");
  });
});
