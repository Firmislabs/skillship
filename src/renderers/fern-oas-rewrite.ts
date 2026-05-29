// src/renderers/fern-oas-rewrite.ts
// Produces a Fern-friendly OAS variant: every operation's operationId becomes
// snake(namespace)_snake(methodName) and tags becomes [namespace], derived from
// the SAME resolveAssignments pass that drives the TS SDK (single source of
// truth). The input OAS string is never mutated; a new JSON string is returned.
import type { CodegenOverlay } from "../overlays/codegen.js";
import {
  resolveAssignments,
  type OperationInfo,
} from "../sdk-plugins/resource-tree.js";

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
 * Returns a new OAS JSON string with operationId + tags rewritten for Fern.
 * Operations are matched back to the doc by their ORIGINAL operationId (unique),
 * so this is robust to whatever path shape the synthetic OAS uses (incl. GraphQL).
 */
export function buildFernOas(
  oasJson: string,
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
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
      const hit = byOpId.get(op.operationId);
      if (!hit) continue;
      op.operationId = hit.operationId;
      op.tags = [hit.namespace];
    }
  }
  return JSON.stringify(doc, null, 2);
}
