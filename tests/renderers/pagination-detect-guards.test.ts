// tests/renderers/pagination-detect-guards.test.ts
// Pagination detection: ambiguity guards, conservatism guards, and edge cases.
// Happy-path auto-detect (cursor/offset/page) lives in pagination-detect-auto.test.ts.
// Tests moved verbatim from pagination-detect-auto.test.ts — not rewritten.

import { describe, expect, test } from "vitest";
import { detectPagination } from "../../src/renderers/pagination-detect.js";
import type { OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
import {
  makeGetOas,
  makePostOas,
  makeOp,
  EMPTY_OVERLAY,
  CURSOR_SCHEMA,
  CURSOR_PARAMS,
  OFFSET_SCHEMA,
  OFFSET_PARAMS,
  type OasParam,
  type OasResponseSchema,
} from "./pagination-detect-helpers.js";

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
// empty ops → empty map + multi-op detection
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
