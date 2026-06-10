// src/renderers/pagination-detect.ts
// Single source of truth for which operations paginate.
// Resolution order:
//   1. overlay.pagination.perOperation[opId] — explicit always wins.
//   2. overlay.pagination.style (product-wide) — applied to qualifying GETs only.
//   3. Conservative auto-detection — only when overlay is silent.
// False negatives are acceptable; false positives are not.

import type { OperationInfo } from "../sdk-plugins/resource-tree.js";
import type { CodegenOverlay } from "../overlays/codegen.js";
import { isObjectLikeSchema } from "../shared/oas-schema.js";

export interface PaginationPlan {
  readonly style: "cursor" | "offset" | "page";
  readonly requestParam: string;
  readonly pageSizeParam: string | null;
  readonly itemsField: string;
  readonly nextField: string | null;
}

// ---- Style-specific conventional defaults ----

type PaginationStyle = "cursor" | "offset" | "page";
type OverlayFields = NonNullable<NonNullable<CodegenOverlay["pagination"]>["fields"]>;

interface StyleDefaults {
  readonly requestParam: string;
  readonly pageSizeParam: string | null;
  readonly itemsField: string;
  readonly nextField: string | null;
}

const STYLE_DEFAULTS: Record<PaginationStyle, StyleDefaults> = {
  cursor: { requestParam: "cursor", pageSizeParam: null, itemsField: "data", nextField: "next_cursor" },
  offset: { requestParam: "offset", pageSizeParam: null, itemsField: "data", nextField: null },
  page:   { requestParam: "page",   pageSizeParam: null, itemsField: "data", nextField: null },
};

function planFromOverlayStyle(
  style: PaginationStyle,
  fields: OverlayFields,
): PaginationPlan {
  const d = STYLE_DEFAULTS[style];
  return {
    style,
    requestParam: fields.requestParam ?? d.requestParam,
    pageSizeParam: fields.pageSizeParam ?? d.pageSizeParam,
    itemsField: fields.itemsField ?? d.itemsField,
    nextField: fields.nextField ?? d.nextField,
  };
}

// ---- Minimal OAS types for reading paths/responses/parameters ----

interface OasSchema {
  readonly type?: string;
  readonly properties?: Record<string, OasSchema>;
  readonly items?: unknown;
}

interface OasParam {
  readonly name?: string;
  readonly in?: string;
  readonly schema?: OasSchema;
}

interface OasOperation {
  readonly operationId?: string;
  readonly parameters?: readonly OasParam[];
  readonly responses?: Record<string, OasResponse>;
}

interface OasResponse {
  readonly content?: Record<string, { readonly schema?: OasSchema }>;
}

type OasPathItem = Record<string, OasOperation>;

interface OasDoc {
  readonly paths?: Record<string, OasPathItem>;
}

// ---- Synonym tables ----

const CURSOR_RESPONSE_FIELDS: ReadonlySet<string> = new Set([
  "next_cursor",
  "nextCursor",
  "next_page_token",
  "cursor",
]);

const CURSOR_REQUEST_PARAMS: ReadonlySet<string> = new Set([
  "cursor",
  "page_token",
  "starting_after",
]);

const PAGE_SIZE_PARAMS: ReadonlySet<string> = new Set(["limit", "per_page", "page_size"]);

// ---- OAS operation lookup helpers ----

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

function findOasOperation(
  doc: OasDoc,
  op: OperationInfo,
): OasOperation | null {
  const pathItem = doc.paths?.[op.path];
  if (!pathItem) return null;
  const method = op.method.toLowerCase();
  // Verify it's one of the known HTTP methods to avoid index access on non-method keys
  if (!HTTP_METHODS.includes(method as typeof HTTP_METHODS[number])) return null;
  const oasOp = pathItem[method];
  if (!oasOp || typeof oasOp !== "object") return null;
  return oasOp;
}

function get200Schema(oasOp: OasOperation): OasSchema | null {
  const resp = oasOp.responses?.["200"];
  if (!resp) return null;
  const jsonContent = resp.content?.["application/json"];
  if (!jsonContent) return null;
  return jsonContent.schema ?? null;
}

function getQueryParams(oasOp: OasOperation): readonly OasParam[] {
  return (oasOp.parameters ?? []).filter((p) => p.in === "query");
}

// ---- Structural qualifier for product-wide style ----
// A GET whose 200 response schema is an object with at least one array property.

function qualifiesForProductWide(oasOp: OasOperation, op: OperationInfo): boolean {
  if (op.method !== "GET") return false;
  const schema = get200Schema(oasOp);
  if (!schema || !isObjectLikeSchema(schema)) return false;
  const props = schema.properties ?? {};
  return Object.values(props).some((p) => p.type === "array");
}

// ---- Auto-detection helpers (≤50 lines each) ----

function autoDetectCursor(
  oasOp: OasOperation,
  props: Record<string, OasSchema>,
  itemsField: string,
): PaginationPlan | null {
  // Find a cursor-like response field
  const nextField = Object.keys(props).find((k) => CURSOR_RESPONSE_FIELDS.has(k)) ?? null;
  if (!nextField) return null;

  // Find a cursor-like request param — schema.type MUST be "string".
  // An integer-typed param named "cursor" is a false positive; the contract forbids those.
  const queryParams = getQueryParams(oasOp);
  const requestParamEntry = queryParams.find(
    (p) => p.name && CURSOR_REQUEST_PARAMS.has(p.name) && p.schema?.type === "string",
  );
  if (!requestParamEntry?.name) return null;
  const requestParam = requestParamEntry.name;

  // Optional page-size param
  const pageSizeEntry = queryParams.find((p) => p.name && PAGE_SIZE_PARAMS.has(p.name));
  const pageSizeParam = pageSizeEntry?.name ?? null;

  return { style: "cursor", requestParam, pageSizeParam, itemsField, nextField };
}

function autoDetectOffsetOrPage(
  oasOp: OasOperation,
  itemsField: string,
): PaginationPlan | null {
  const queryParams = getQueryParams(oasOp);
  const intParams = new Set(
    queryParams
      .filter((p) => p.schema?.type === "integer" && p.name)
      .map((p) => p.name as string),
  );

  // page detection: page + (per_page | page_size)
  if (intParams.has("page")) {
    const pageSizeParam = intParams.has("per_page")
      ? "per_page"
      : intParams.has("page_size")
        ? "page_size"
        : null;
    if (pageSizeParam !== null) {
      return { style: "page", requestParam: "page", pageSizeParam, itemsField, nextField: null };
    }
  }

  // offset detection: offset + limit
  if (intParams.has("offset") && intParams.has("limit")) {
    return { style: "offset", requestParam: "offset", pageSizeParam: "limit", itemsField, nextField: null };
  }

  return null;
}

// ---- Main exported function ----

export function detectPagination(
  ops: readonly OperationInfo[],
  oasJson: string,
  overlay: CodegenOverlay,
): ReadonlyMap<string, PaginationPlan> {
  const doc = JSON.parse(oasJson) as OasDoc;
  const result = new Map<string, PaginationPlan>();
  const paginationOverlay = overlay.pagination;

  for (const op of ops) {
    const plan = resolveOperationPlan(op, doc, paginationOverlay);
    if (plan !== null) {
      result.set(op.operationId, plan);
    }
  }

  return result;
}

function resolveOperationPlan(
  op: OperationInfo,
  doc: OasDoc,
  paginationOverlay: CodegenOverlay["pagination"],
): PaginationPlan | null {
  const fields: OverlayFields = paginationOverlay?.fields ?? {};

  // 1. perOperation explicit style wins
  const perOpStyle = paginationOverlay?.perOperation?.[op.operationId];
  if (perOpStyle !== undefined) {
    return planFromOverlayStyle(perOpStyle, fields);
  }

  // 2. product-wide style — applied only to structurally qualifying GETs
  const productStyle = paginationOverlay?.style;
  if (productStyle !== undefined) {
    const oasOp = findOasOperation(doc, op);
    if (oasOp !== null && qualifiesForProductWide(oasOp, op)) {
      return planFromOverlayStyle(productStyle, fields);
    }
    return null;
  }

  // 3. Conservative auto-detection (overlay is silent)
  if (op.method !== "GET") return null;
  const oasOp = findOasOperation(doc, op);
  if (oasOp === null) return null;
  const schema = get200Schema(oasOp);
  // OAS 3.1 makes `type: object` optional when `properties` is present.
  // Accept object-like schemas: explicit type:"object" OR propertied schema without type.
  // Still exclude arrays and primitives (they lack a meaningful `properties` map).
  if (!schema || !isObjectLikeSchema(schema)) return null;

  // Hoist the exactly-one-array-prop check — both auto-detect branches need it.
  const props = schema.properties ?? {};
  const arrayProps = Object.keys(props).filter((k) => props[k]?.type === "array");
  if (arrayProps.length !== 1) return null;
  const itemsField = arrayProps[0]!;

  // Cursor checked first (takes precedence over offset/page)
  const cursorPlan = autoDetectCursor(oasOp, props, itemsField);
  if (cursorPlan !== null) return cursorPlan;

  return autoDetectOffsetOrPage(oasOp, itemsField);
}
