// src/sdk-plugins/mcp-catalog.ts
// Catalog computation + emitter for the MCP server renderer (Wave 2, Task 3).
//
// Two concerns live here:
//   1. computeCatalogEntries  — pure computation; same single-source passes as
//      the SDK and Fern rewrite (resolveAssignments + detectPagination) so
//      accessor names and pagination flags can never drift.
//   2. generateMcpCatalogModule — emits the generated src/mcp-catalog.ts that
//      the MCP server reads at startup. Data-only: two interfaces + CATALOG const.
//
// Emission helpers live in ./mcp-catalog-emit.ts (auth/auth-emit precedent) so
// both files stay under the 300-line house rule.

import type { CodegenOverlay } from "../overlays/codegen.js";
import type { OperationInfo } from "./resource-tree.js";
import { resolveAssignments } from "./resource-tree.js";
import { detectPagination } from "../renderers/pagination-detect.js";
import { camelToSnake } from "../renderers/fern-oas-rewrite.js";
import { ANNOTATION_EXTENSION_KEY, ANNOTATION_PAIRS } from "../shared/annotations.js";
import { emitCatalogModule } from "./mcp-catalog-emit.js";

// ---- Public interfaces ----

export interface CatalogParam {
  readonly name: string;
  readonly in: "path" | "query" | "body";
  readonly type: string;
  readonly required: boolean;
}

export interface CatalogEntry {
  readonly id: string;
  readonly accessor: readonly [string, string];
  readonly httpMethod: string;
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly searchText: string;
  readonly params: readonly CatalogParam[];
  readonly annotations: {
    readonly destructive: boolean;
    readonly readOnly: boolean;
    readonly idempotent: boolean;
  };
  readonly paginated: boolean;
}

// ---- Internal OAS shape (minimal, read-only) ----

interface OasSchema {
  readonly type?: string;
}

interface OasParam {
  readonly name?: unknown;
  readonly in?: unknown;
  readonly schema?: OasSchema;
  readonly required?: unknown;
}

interface OasRequestBody {
  readonly required?: unknown;
  readonly content?: Record<string, unknown>;
}

interface OasOperation {
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly parameters?: readonly OasParam[];
  readonly requestBody?: OasRequestBody;
  readonly [key: string]: unknown;
}

type OasPathItem = Record<string, OasOperation>;

interface OasDoc {
  readonly paths?: Record<string, OasPathItem>;
}

// ---- Heuristic annotation table ----

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "PUT", "DELETE"]);
const DESTRUCTIVE_METHODS: ReadonlySet<string> = new Set(["DELETE"]);

/**
 * The set of extension keys consumed by computeAnnotations.
 * Derived from ANNOTATION_PAIRS so it cannot drift from the canonical table.
 * Exported for drift-guard tests.
 */
export const CONSUMED_ANNOTATION_KEYS: ReadonlySet<string> = new Set(
  ANNOTATION_PAIRS.map((p) => p[0]),
);

function computeAnnotations(
  method: string,
  opDef: OasOperation,
): { destructive: boolean; readOnly: boolean; idempotent: boolean } {
  const ext = opDef[ANNOTATION_EXTENSION_KEY];
  const hasExt = ext !== null && typeof ext === "object" && !Array.isArray(ext);
  const extObj = hasExt ? (ext as Record<string, unknown>) : {};

  const m = method.toUpperCase();

  // Compute heuristics from method sets
  const heuristics: Record<string, boolean> = {
    destructive: DESTRUCTIVE_METHODS.has(m),
    readOnly: READ_ONLY_METHODS.has(m),
    idempotent: IDEMPOTENT_METHODS.has(m),
  };

  // Extension beats heuristic per key — iterate ANNOTATION_PAIRS so this
  // function's consumed keys are always in sync with the canonical table.
  const result: Record<string, boolean> = {};
  for (const [extKey] of ANNOTATION_PAIRS) {
    const extVal = extObj[extKey];
    result[extKey] = typeof extVal === "boolean" ? extVal : (heuristics[extKey] ?? false);
  }

  return {
    destructive: result["destructive"] ?? false,
    readOnly: result["readOnly"] ?? false,
    idempotent: result["idempotent"] ?? false,
  };
}

// ---- Parameter extraction ----

function extractParams(opDef: OasOperation): readonly CatalogParam[] {
  const out: CatalogParam[] = [];

  const parameters = opDef.parameters ?? [];
  for (const p of parameters) {
    const name = typeof p.name === "string" ? p.name : null;
    const location = typeof p.in === "string" ? p.in : null;
    if (name === null || location === null) continue;
    if (location !== "path" && location !== "query") continue;
    const type = typeof p.schema?.type === "string" ? p.schema.type : "string";
    const required = p.required === true;
    out.push({ name, in: location as "path" | "query", type, required });
  }

  const requestBody = opDef.requestBody;
  if (requestBody !== undefined && requestBody !== null) {
    const required = requestBody.required === true;
    out.push({ name: "body", in: "body", type: "object", required });
  }

  return out;
}

// ---- OAS doc lookup ----

const HTTP_METHODS_SET: ReadonlySet<string> = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
]);

function findOasOp(doc: OasDoc, op: OperationInfo): OasOperation | null {
  const pathItem = doc.paths?.[op.path];
  if (!pathItem) return null;
  const method = op.method.toLowerCase();
  if (!HTTP_METHODS_SET.has(method)) return null;
  const oasOp = pathItem[method];
  if (!oasOp || typeof oasOp !== "object") return null;
  return oasOp;
}

// ---- Main computation ----

/**
 * Computes the full catalog from ops, oasJson, and overlay.
 * Mirrors detectPagination's signature style.
 * Entries are sorted ascending by id (deterministic).
 */
export function computeCatalogEntries(
  ops: readonly OperationInfo[],
  oasJson: string,
  overlay: CodegenOverlay,
): readonly CatalogEntry[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const plans = detectPagination(ops, oasJson, overlay);
  const assignments = resolveAssignments(ops, overlay);

  const entries: CatalogEntry[] = [];
  for (const a of assignments) {
    const { op, namespace, methodName } = a;
    const id = `${camelToSnake(namespace)}_${camelToSnake(methodName)}`;
    const oasOp = findOasOp(doc, op);
    const summary = typeof oasOp?.summary === "string" ? oasOp.summary : "";
    const description = typeof oasOp?.description === "string" ? oasOp.description : "";
    const params = oasOp ? extractParams(oasOp) : [];
    const annotations = computeAnnotations(op.method, oasOp ?? {});
    const paginated = plans.has(op.operationId);
    const searchText = `${id} ${summary} ${op.path} ${description}`.toLowerCase();

    entries.push({
      id,
      accessor: [namespace, methodName],
      httpMethod: op.method.toUpperCase(),
      path: op.path,
      summary,
      description,
      searchText,
      params,
      annotations,
      paginated,
    });
  }

  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return entries;
}

// ---- Emitter ----

/**
 * Emits the generated src/mcp-catalog.ts module.
 * Contains only: file header comment, two interfaces, CATALOG const.
 * No functions — data-only module.
 */
export function generateMcpCatalogModule(entries: readonly CatalogEntry[]): string {
  return emitCatalogModule(entries);
}
