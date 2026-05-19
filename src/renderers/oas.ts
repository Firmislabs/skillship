// src/renderers/oas.ts
import type { Database as Sqlite3Database } from "better-sqlite3";
import { readBestClaim } from "./claims.js";
import type { CodegenOverlay } from "../overlays/codegen.js";

export interface RenderOasInput {
  readonly db: Sqlite3Database;
  readonly productId: string;
  readonly productName: string;
  readonly overlay: CodegenOverlay;
}

interface OpRow { readonly id: string; readonly surfaceId: string; readonly isGraphql: boolean; }

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];
const GQL_METHODS = ["QUERY", "MUTATION", "SUBSCRIPTION"];

export function renderSyntheticOpenApi(input: RenderOasInput): string {
  const ops = listOperations(input.db, input.productId);
  const paths: Record<string, Record<string, unknown>> = {};
  const schemas: Record<string, unknown> = {};
  const securitySchemes: Record<string, unknown> = {};
  const unmapped: { op: string; reason: string }[] = [];

  for (const op of ops) {
    const rawMethod = readBestClaim(input.db, op.id, "method") ?? ""; // UPPERCASE in graph
    const name = readBestClaim(input.db, op.id, "path_or_name") ?? op.id;
    const httpMethod = rawMethod.toLowerCase();
    if (op.isGraphql || GQL_METHODS.includes(rawMethod.toUpperCase())) {
      const path = `/graphql#${name}`;
      (paths[path] ??= {}).post = buildOperation(input.db, op.id, schemas, op.isGraphql, securitySchemes);
      continue;
    }
    if (!HTTP_METHODS.includes(httpMethod)) {
      unmapped.push({ op: op.id, reason: `unmappable method '${rawMethod}'` });
      continue;
    }
    const path = name.startsWith("/") ? name : `/${name}`;
    (paths[path] ??= {})[httpMethod] = buildOperation(input.db, op.id, schemas, false, securitySchemes);
  }

  const sortedPaths: Record<string, Record<string, unknown>> = {};
  for (const p of Object.keys(paths).sort()) sortedPaths[p] = sortKeys(paths[p]!);

  // Top-level keys follow canonical OpenAPI document order (openapi, info,
  // paths, components) by deliberate product decision, not alphabetical sort.
  // Determinism (spec §2.5) is satisfied because this order is fixed across
  // runs; nested data-derived objects ARE alphabetically sorted via sortKeys.
  const doc: Record<string, unknown> = {
    openapi: "3.1.0",
    info: { title: input.productName, version: surfaceVersion(input.db, input.productId) },
    paths: sortedPaths,
    components: { schemas: sortKeys(schemas), securitySchemes: sortKeys(securitySchemes) },
  };
  if (unmapped.length > 0) doc["x-skillship-unmapped"] = unmapped.sort((a, b) => a.op.localeCompare(b.op));
  return JSON.stringify(doc, null, 2);
}

function listOperations(db: Sqlite3Database, productId: string): OpRow[] {
  const rows = db.prepare(
    `SELECT n.id AS id, s.id AS surfaceId FROM nodes n
       JOIN nodes s ON s.id = n.parent_id
      WHERE n.kind = 'operation' AND s.parent_id = ? ORDER BY n.id`,
  ).all(productId) as { id: string; surfaceId: string }[];
  return rows.map(r => ({
    id: r.id,
    surfaceId: r.surfaceId,
    isGraphql: r.surfaceId.startsWith("srf_"),
  }));
}

function surfaceVersion(db: Sqlite3Database, productId: string): string {
  const rows = db.prepare(
    `SELECT id FROM nodes WHERE kind = 'surface' AND parent_id = ? ORDER BY id`,
  ).all(productId) as { id: string }[];
  for (const r of rows) {
    const v = readBestClaim(db, r.id, "version");
    if (v !== undefined) return v;
  }
  return "0.0.0";
}

function buildOperation(db: Sqlite3Database, opId: string, schemas: Record<string, unknown>, isGraphql: boolean, securitySchemes: Record<string, unknown>): Record<string, unknown> {
  const op: Record<string, unknown> = { operationId: opId };
  const summary = readBestClaim(db, opId, "summary");
  if (summary !== undefined) op.summary = summary;
  const description = readBestClaim(db, opId, "description");
  if (description !== undefined) op.description = description;
  const { parameters, requestBody } = buildParams(db, opId, isGraphql);
  if (parameters.length > 0) op.parameters = parameters;
  if (requestBody !== undefined) op.requestBody = requestBody;
  op.responses = buildResponses(db, opId, schemas);
  const sec = buildSecurity(db, opId, securitySchemes);
  if (sec.length > 0) op.security = sec;
  const tags = buildTags(db, opId, isGraphql);
  if (tags.length > 0) op.tags = tags;
  return op;
}

function buildParams(db: Sqlite3Database, opId: string, isGraphql: boolean): {
  parameters: Record<string, unknown>[];
  requestBody: Record<string, unknown> | undefined;
} {
  if (isGraphql) {
    const raw = readJson(db, opId, "params");
    const args = Array.isArray(raw) ? (raw as unknown[]).map(String) : [];
    const parameters = args.map((a) => {
      const pname = (a.split(":")[0] ?? a).trim();
      return { name: pname, in: "query", required: false, schema: { type: "string" } };
    });
    return { parameters, requestBody: undefined };
  }
  const rows = db.prepare(
    `SELECT id FROM nodes WHERE kind = 'parameter' AND parent_id = ? ORDER BY id`,
  ).all(opId) as { id: string }[];
  const parameters: Record<string, unknown>[] = [];
  let requestBody: Record<string, unknown> | undefined;
  for (const r of rows) {
    const location = readBestClaim(db, r.id, "location") ?? "query";
    const pname = readBestClaim(db, r.id, "name") ?? "";
    const required = readBool(db, r.id, "required");
    const type = readBestClaim(db, r.id, "type") ?? "string";
    if (location === "body") {
      requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } };
      continue;
    }
    parameters.push({ name: pname, in: location, required, schema: { type: mapType(type) } });
  }
  return { parameters, requestBody };
}

function buildResponses(db: Sqlite3Database, opId: string, schemas: Record<string, unknown>): Record<string, unknown> {
  const rows = db.prepare(
    `SELECT id FROM nodes WHERE kind = 'response_shape' AND parent_id = ? ORDER BY id`,
  ).all(opId) as { id: string }[];
  const responses: Record<string, unknown> = {};
  for (const r of rows) {
    const status = String(readJson(db, r.id, "status_code") ?? "default");
    const ct = readBestClaim(db, r.id, "content_type") ?? "application/json";
    const ref = readBestClaim(db, r.id, "schema_ref");
    if (ref !== undefined) schemas[ref] = { type: "object" };
    responses[status] = {
      description: status,
      content: { [ct]: { schema: ref !== undefined ? { $ref: `#/components/schemas/${ref}` } : { type: "object" } } },
    };
  }
  if (Object.keys(responses).length === 0) responses["200"] = { description: "OK" };
  return sortKeys(responses);
}

function buildSecurity(db: Sqlite3Database, opId: string, sink: Record<string, unknown>): Record<string, string[]>[] {
  const rows = db.prepare(
    `SELECT DISTINCT to_node_id AS authId FROM edges WHERE from_node_id = ? AND kind = 'auth_requires'`,
  ).all(opId) as { authId: string }[];
  const out: Record<string, string[]>[] = [];
  for (const r of rows.sort((a, b) => a.authId.localeCompare(b.authId))) {
    const type = (readBestClaim(db, r.authId, "type") ?? "bearer").toLowerCase();
    const key = `${type}_${r.authId}`;
    if (type === "bearer" || type === "http") sink[key] = { type: "http", scheme: "bearer" };
    else if (type === "apikey") sink[key] = { type: "apiKey", in: "header", name: readBestClaim(db, r.authId, "param_name") ?? "Authorization" };
    else sink[key] = { type: "http", scheme: "bearer" };
    out.push({ [key]: [] });
  }
  return out;
}

function buildTags(db: Sqlite3Database, opId: string, isGraphql: boolean): string[] {
  if (isGraphql) {
    const m = (readBestClaim(db, opId, "method") ?? "QUERY").toLowerCase();
    return [m];
  }
  const path = readBestClaim(db, opId, "path_or_name") ?? "";
  const seg = path
    .split("/")
    .map(s => s.trim())
    .find(s => s.length > 0 && !s.startsWith("{"));
  return seg !== undefined ? [seg] : [];
}

function readBool(db: Sqlite3Database, nodeId: string, field: string): boolean {
  return readJson(db, nodeId, field) === true;
}

function readJson(db: Sqlite3Database, nodeId: string, field: string): unknown {
  const row = db.prepare(
    `SELECT value_json FROM claims WHERE node_id = ? AND field = ? ORDER BY id LIMIT 1`,
  ).get(nodeId, field) as { value_json: string } | undefined;
  if (row === undefined) return undefined;
  try { return JSON.parse(row.value_json); } catch { return undefined; }
}

function mapType(t: string): string {
  const k = t.toLowerCase();
  if (["integer", "number", "boolean", "array", "object", "string"].includes(k)) return k;
  return "string";
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k]!;
  return out;
}
