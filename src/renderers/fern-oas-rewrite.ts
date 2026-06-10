// src/renderers/fern-oas-rewrite.ts
// Produces a Fern-friendly OAS variant: every operation's operationId becomes
// snake(namespace)_snake(methodName) and tags becomes [namespace], derived from
// the SAME resolveAssignments pass that drives the TS SDK (single source of
// truth). The input OAS string is never mutated; a new JSON string is returned.
// Additionally stamps x-fern-pagination on operations with a known plan
// (passed in from the shared detectPagination output — NOT re-detected here).
import type { CodegenOverlay } from "../overlays/codegen.js";
import {
  resolveAssignments,
  type OperationInfo,
} from "../sdk-plugins/resource-tree.js";
import type { PaginationPlan } from "./pagination-detect.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
]);

interface MutOp {
  operationId?: string;
  tags?: string[];
  [k: string]: unknown;
}
type MutPathItem = Record<string, MutOp>;
interface MutDoc {
  paths?: Record<string, MutPathItem>;
  [k: string]: unknown;
}

/** Converts a camelCase/PascalCase identifier to snake_case. */
export function camelToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Builds the x-fern-pagination stamp for an operation.
 * cursor (nextField non-null) → { cursor, next_cursor, results } with $request./$response. prefixes.
 * cursor (nextField null) → null; no stamp emitted (Fern requires next_cursor for cursor pagination).
 * offset → { offset, results } with $request./$response. prefixes.
 * page → offset form using the page requestParam (Fern has no distinct page type
 *        at this syntax level — recorded in KNOWN_GAPS by Task 12).
 */
function buildPaginationStamp(plan: PaginationPlan): Record<string, string> | null {
  if (plan.style === "cursor") {
    // cursor with no nextField cannot be expressed in Fern's pagination config — skip.
    if (plan.nextField === null) return null;
    return {
      cursor: `$request.${plan.requestParam}`,
      next_cursor: `$response.${plan.nextField}`,
      results: `$response.${plan.itemsField}`,
    };
  }
  if (plan.style === "offset") {
    return {
      offset: `$request.${plan.requestParam}`,
      results: `$response.${plan.itemsField}`,
    };
  }
  // page: emit the offset form using the page param (Fern has no distinct page type).
  return {
    offset: `$request.${plan.requestParam}`,
    results: `$response.${plan.itemsField}`,
  };
}

/**
 * Returns a new OAS JSON string with:
 * 1. operationId + tags rewritten for Fern (snake(ns)_snake(method) / [ns]).
 * 2. x-fern-pagination stamped per operation WHERE a plan exists in the map.
 *
 * Operations are matched back to the doc by their ORIGINAL operationId (unique),
 * so this is robust to whatever path shape the synthetic OAS uses (incl. GraphQL).
 * The pagination plans map uses ORIGINAL operationIds (before the rewrite) since
 * those are the keys detectPagination produces. The stamp is applied AFTER the
 * operationId rewrite so the op object already has the new id, but the lookup
 * key is saved before rewriting.
 *
 * The $request./<requestParam> refs reference ORIGINAL OAS parameter names —
 * Fern reads the spec's parameter names, unaffected by operationId rewrite.
 */
export function buildFernOas(
  oasJson: string,
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
  plans: ReadonlyMap<string, PaginationPlan>,
): string {
  const doc = JSON.parse(oasJson) as MutDoc;
  const byOpId = new Map<string, { operationId: string; namespace: string }>();
  for (const a of resolveAssignments(ops, overlay)) {
    byOpId.set(a.op.operationId, {
      operationId: `${camelToSnake(a.namespace)}_${camelToSnake(a.methodName)}`,
      namespace: a.namespace,
    });
  }
  const paths = doc.paths ?? {};
  for (const pathKey of Object.keys(paths)) {
    const item = paths[pathKey]!;
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = item[method];
      if (!op || typeof op !== "object" || typeof op.operationId !== "string") continue;
      const originalOpId = op.operationId;
      const hit = byOpId.get(originalOpId);
      if (hit) {
        op.operationId = hit.operationId;
        op.tags = [hit.namespace];
      }
      const plan = plans.get(originalOpId);
      if (plan !== undefined) {
        const stamp = buildPaginationStamp(plan);
        if (stamp !== null) {
          op["x-fern-pagination"] = stamp;
        }
      }
    }
  }
  return JSON.stringify(doc, null, 2);
}
