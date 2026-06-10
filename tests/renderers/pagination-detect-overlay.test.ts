// tests/renderers/pagination-detect-overlay.test.ts
// Pagination detection: overlay tiers 1–2.
// Covers: perOperation override (tier 1) and product-wide style (tier 2).
// Tests are VERBATIM from pagination-detect.test.ts — moved, not rewritten.

import { describe, expect, test } from "vitest";
import type { PaginationPlan } from "../../src/renderers/pagination-detect.js";
import { detectPagination } from "../../src/renderers/pagination-detect.js";
import type { OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import {
  makeGetOas,
  makePostOas,
  makeOp,
  EMPTY_OVERLAY,
  CURSOR_SCHEMA,
  CURSOR_PARAMS,
  OFFSET_SCHEMA,
  OFFSET_PARAMS,
  PAGE_SCHEMA,
  PAGE_PARAMS,
} from "./pagination-detect-helpers.js";

// Keep PaginationPlan import used (it's referenced in type assertions below)
type _PlanAssert = PaginationPlan;

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
// OVERLAY: product-wide style + object-like schema (no type keyword) — Fix 2 RED
// ============================

describe("overlay product-wide style — object-like schema without type keyword (OAS 3.1)", () => {
  test("product-wide cursor applied to qualifying GET whose 200 schema has properties but NO type keyword", () => {
    // Fix 2: qualifiesForProductWide (tier-2 gate) currently checks schema.type === "object" literally.
    // OAS 3.1 makes type:object optional when properties is present. This test MUST FAIL before the fix
    // and PASS after isObjectLikeSchema covers the tier-2 gate.
    const overlay = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: { requestParam: "cursor", nextField: "next_cursor", itemsField: "data" },
        perOperation: {},
      },
    });
    // Schema has properties and array child but NO type keyword
    const noTypeSchema = {
      properties: {
        data: { type: "array", items: {} },
        next_cursor: { type: "string" },
      },
    };
    const oasJson = makeGetOas("listItems", CURSOR_PARAMS, noTypeSchema);
    const ops: readonly OperationInfo[] = [makeOp("listItems")];
    const result = detectPagination(ops, oasJson, overlay);
    // product-wide overlay must apply (currently fails at tier-2 gate due to literal type check)
    expect(result.has("listItems")).toBe(true);
    const plan = result.get("listItems")!;
    expect(plan.style).toBe("cursor");
    expect(plan.requestParam).toBe("cursor");
    expect(plan.nextField).toBe("next_cursor");
    expect(plan.itemsField).toBe("data");
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
    const twoArraySchema = {
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
