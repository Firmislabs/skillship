// tests/renderers/pagination-detect.test.ts
// TDD: comprehensive tests for detectPagination — written BEFORE implementation (RED).
// Covers: overlay perOperation override, product-wide overlay style+fields,
// auto-detect cursor/page/offset, ambiguity → absent, synonym support,
// nextField null for offset/page.

import { describe, expect, test } from "vitest";
import type { PaginationPlan } from "../../src/renderers/pagination-detect.js";
import { detectPagination } from "../../src/renderers/pagination-detect.js";
import type { OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

// ---- OAS builder helpers ----

interface OasParam {
  name: string;
  in: string;
  schema?: { type: string };
}

interface OasResponseSchema {
  type: string;
  properties?: Record<string, { type: string; items?: unknown }>;
}

function makeGetOas(
  opId: string,
  params: OasParam[],
  responseSchema: OasResponseSchema,
): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: opId,
          tags: ["items"],
          parameters: params,
          responses: {
            "200": {
              content: {
                "application/json": { schema: responseSchema },
              },
            },
          },
        },
      },
    },
  });
}

function makePostOas(opId: string): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {
      "/token": {
        post: {
          operationId: opId,
          tags: ["auth"],
          parameters: [],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: {} },
                      next_cursor: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

function makeOp(opId: string, method = "GET", path = "/items"): OperationInfo {
  return { operationId: opId, tags: ["items"], method, path };
}

const EMPTY_OVERLAY = CodegenOverlaySchema.parse({});

// ---- cursor auto-detect helpers ----

const CURSOR_SCHEMA: OasResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: {} },
    next_cursor: { type: "string" },
  },
};

const CURSOR_PARAMS: OasParam[] = [
  { name: "cursor", in: "query", schema: { type: "string" } },
  { name: "limit", in: "query", schema: { type: "integer" } },
];

// ---- offset auto-detect helpers ----

const OFFSET_SCHEMA: OasResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: {} },
    total: { type: "integer" },
  },
};

const OFFSET_PARAMS: OasParam[] = [
  { name: "offset", in: "query", schema: { type: "integer" } },
  { name: "limit", in: "query", schema: { type: "integer" } },
];

// ---- page auto-detect helpers ----

const PAGE_SCHEMA: OasResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: {} },
    total: { type: "integer" },
  },
};

const PAGE_PARAMS: OasParam[] = [
  { name: "page", in: "query", schema: { type: "integer" } },
  { name: "per_page", in: "query", schema: { type: "integer" } },
];

// ============================
// OVERLAY: perOperation wins
// ============================

describe("overlay perOperation override", () => {
  test("perOperation cursor wins over auto-detect result", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: {},
        perOperation: { listItems: "cursor" },
      },
    });
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("cursor");
  });

  test("perOperation cursor + explicit fields uses those fields", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: {
          requestParam: "after",
          pageSizeParam: "page_size",
          itemsField: "results",
          nextField: "next_token",
        },
        perOperation: { listItems: "cursor" },
      },
    });
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    const plan = result.get("listItems")!;
    expect(plan.requestParam).toBe("after");
    expect(plan.pageSizeParam).toBe("page_size");
    expect(plan.itemsField).toBe("results");
    expect(plan.nextField).toBe("next_token");
  });

  test("perOperation cursor with no fields falls back to cursor defaults", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: {},
        perOperation: { listItems: "cursor" },
      },
    });
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    const plan = result.get("listItems")!;
    expect(plan.requestParam).toBe("cursor");
    expect(plan.nextField).toBe("next_cursor");
    expect(plan.itemsField).toBe("data");
  });

  test("perOperation offset with no fields falls back to offset defaults", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "offset",
        fields: {},
        perOperation: { listItems: "offset" },
      },
    });
    const oasJson = makeGetOas("listItems", OFFSET_PARAMS, OFFSET_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("offset");
    expect(plan.requestParam).toBe("offset");
    expect(plan.nextField).toBeNull();
    expect(plan.itemsField).toBe("data");
  });

  test("perOperation page with no fields falls back to page defaults", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "page",
        fields: {},
        perOperation: { listItems: "page" },
      },
    });
    const oasJson = makeGetOas("listItems", PAGE_PARAMS, PAGE_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("page");
    expect(plan.requestParam).toBe("page");
    expect(plan.nextField).toBeNull();
    expect(plan.itemsField).toBe("data");
  });
});

// ============================
// OVERLAY: product-wide style
// ============================

describe("overlay product-wide style + fields", () => {
  test("product-wide cursor applied to qualifying GET operation", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: { itemsField: "items", nextField: "next_page_token", requestParam: "cursor" },
        perOperation: {},
      },
    });
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("cursor");
    expect(plan.itemsField).toBe("items");
    expect(plan.nextField).toBe("next_page_token");
    expect(plan.requestParam).toBe("cursor");
  });

  test("product-wide style is NOT applied to POST operation (structural guard)", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: {},
        perOperation: {},
      },
    });
    const oasJson = makePostOas("createToken");
    const ops: readonly OperationInfo[] = [
      { operationId: "createToken", tags: ["auth"], method: "POST", path: "/token" },
    ];
    const result = detectPagination(ops, oasJson, overlay);
    // POST should not get product-wide pagination even if it has array in response
    expect(result.has("createToken")).toBe(false);
  });

  test("product-wide style applied only to GET with array in 200 response", () => {
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "offset",
        fields: { requestParam: "offset", itemsField: "data" },
        perOperation: {},
      },
    });
    const oasJson = makeGetOas("listItems", OFFSET_PARAMS, OFFSET_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    expect(result.has("listItems")).toBe(true);
    expect(result.get("listItems")!.style).toBe("offset");
  });
});

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

// ============================
// AMBIGUITY → absent (false-negative safe)
// ============================

describe("ambiguity → no plan", () => {
  test("two array properties → no plan", () => {
    const schema: OasResponseSchema = {
      type: "object",
      properties: {
        data: { type: "array", items: {} },
        errors: { type: "array", items: {} },
        next_cursor: { type: "string" },
      },
    };
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, schema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(false);
  });

  test("zero array properties → no plan", () => {
    const schema: OasResponseSchema = {
      type: "object",
      properties: {
        total: { type: "integer" },
        next_cursor: { type: "string" },
      },
    };
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, schema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(false);
  });

  test("no matching param pair → no plan", () => {
    const schema: OasResponseSchema = {
      type: "object",
      properties: {
        data: { type: "array", items: {} },
      },
    };
    const params: OasParam[] = [
      { name: "search", in: "query", schema: { type: "string" } },
    ];
    const oasJson = makeGetOas("listItems", params, schema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(false);
  });

  test("POST list operation with cursor-like response → no plan (auto-detect only for GET)", () => {
    const oasJson = makePostOas("createItems");
    const ops: readonly OperationInfo[] = [
      { operationId: "createItems", tags: ["items"], method: "POST", path: "/token" },
    ];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("createItems")).toBe(false);
  });

  test("response schema is not an object type → no plan", () => {
    const schema = { type: "array" } as OasResponseSchema;
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, schema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(false);
  });

  test("missing 200 response → no plan", () => {
    const oasJson = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "test", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            tags: ["items"],
            parameters: CURSOR_PARAMS,
            responses: {
              "201": { description: "created" },
            },
          },
        },
      },
    });
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(false);
  });
});

// ============================
// AUTO-DETECT: cursor false-positive guard (string type required)
// ============================

describe("auto-detect cursor false-positive guard", () => {
  test("integer-typed param named cursor → no plan (string type required)", () => {
    // The contract: false positives are NOT acceptable.
    // A query param named "cursor" with schema.type === "integer" must NOT trigger
    // cursor auto-detection — only string-typed (or schema-absent) should NOT match;
    // strictly: only schema.type === "string" is accepted.
    const params: OasParam[] = [
      { name: "cursor", in: "query", schema: { type: "integer" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ];
    const oasJson = makeGetOas("listItems", params, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(false);
  });
});

// ============================
// OVERLAY: product-wide itemsField default
// ============================

describe("overlay product-wide itemsField default", () => {
  test("product-wide overlay on qualifying GET with two array props and no fields.itemsField → itemsField is 'data'", () => {
    // Pins the documented default-guess for overlay-driven mode.
    // When fields.itemsField is absent the plan must resolve to CURSOR_DEFAULTS.itemsField === "data".
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: { requestParam: "cursor", nextField: "next_cursor" },
        perOperation: {},
      },
    });
    const twoArraySchema: OasResponseSchema = {
      type: "object",
      properties: {
        data: { type: "array", items: {} },
        errors: { type: "array", items: {} },
        next_cursor: { type: "string" },
      },
    };
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, twoArraySchema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    // product-wide overlay qualifies on ≥1 array prop (structural guard), so plan IS present
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.itemsField).toBe("data");
  });
});

// ============================
// cursor takes precedence over offset when both sets of params present
// ============================

describe("cursor wins over offset when both param sets present", () => {
  test("cursor params + offset params → cursor style wins", () => {
    const params: OasParam[] = [
      { name: "cursor", in: "query", schema: { type: "string" } },
      { name: "offset", in: "query", schema: { type: "integer" } },
      { name: "limit", in: "query", schema: { type: "integer" } },
    ];
    const oasJson = makeGetOas("listItems", params, CURSOR_SCHEMA);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(true);
    expect(result.get("listItems")!.style).toBe("cursor");
  });
});

// ============================
// empty ops → empty map
// ============================

describe("edge cases", () => {
  test("empty ops array returns empty map", () => {
    const result = detectPagination([], "{}", EMPTY_OVERLAY);
    expect(result.size).toBe(0);
  });

  test("multiple ops — each detected independently", () => {
    const oasJson = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "test", version: "1.0.0" },
      paths: {
        "/items": {
          get: {
            operationId: "listItems",
            tags: ["items"],
            parameters: CURSOR_PARAMS,
            responses: {
              "200": {
                content: {
                  "application/json": { schema: CURSOR_SCHEMA },
                },
              },
            },
          },
        },
        "/users": {
          get: {
            operationId: "listUsers",
            tags: ["users"],
            parameters: OFFSET_PARAMS,
            responses: {
              "200": {
                content: {
                  "application/json": { schema: OFFSET_SCHEMA },
                },
              },
            },
          },
        },
        "/token": {
          post: {
            operationId: "createToken",
            tags: ["auth"],
            parameters: [],
            responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
          },
        },
      },
    });
    const ops: readonly OperationInfo[] = [
      makeOp("listItems", "GET", "/items"),
      { operationId: "listUsers", tags: ["users"], method: "GET", path: "/users" },
      { operationId: "createToken", tags: ["auth"], method: "POST", path: "/token" },
    ];
    const result = detectPagination(ops, oasJson, EMPTY_OVERLAY);
    expect(result.has("listItems")).toBe(true);
    expect(result.get("listItems")!.style).toBe("cursor");
    expect(result.has("listUsers")).toBe(true);
    expect(result.get("listUsers")!.style).toBe("offset");
    expect(result.has("createToken")).toBe(false);
  });
});
