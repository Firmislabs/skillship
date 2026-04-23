import { parse as parseYaml } from "yaml";
import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { emitOperation } from "./openapi3-ops.js";
import { isObject, stableId } from "./openapi3-util.js";

export const OPENAPI3_EXTRACTOR = "openapi@3";

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export interface OpenApiDoc {
  readonly openapi?: string;
  readonly info?: { title?: string; version?: string };
  readonly servers?: { url?: string }[];
  readonly paths?: Record<string, Record<string, unknown>>;
  readonly components?: {
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
}

export interface ExtractOpenApi3Input {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

export interface ExtractOpenApi3DocInput {
  readonly doc: OpenApiDoc;
  readonly source: SourceNode;
  readonly productId: string;
  readonly extractor?: string;
}

export function extractOpenApi3(input: ExtractOpenApi3Input): Extraction {
  const doc = parseDoc(input.bytes, input.source.content_type);
  return extractOpenApi3Doc({
    doc,
    source: input.source,
    productId: input.productId,
  });
}

export function extractOpenApi3Doc(
  input: ExtractOpenApi3DocInput,
): Extraction {
  const { doc } = input;
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];

  const surfaceId = stableId("sfc", [
    input.productId,
    "rest",
    doc.info?.version ?? "",
  ]);
  nodes.push({ id: surfaceId, kind: "surface", parent_id: input.productId });
  edges.push({
    kind: "exposes",
    from_node_id: input.productId,
    to_node_id: surfaceId,
  });
  pushSurfaceClaims(doc, surfaceId, claims);

  const authIds = emitAuthSchemes(doc, input.productId, nodes, claims);

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const opDef = pathItem[method];
      if (!isObject(opDef)) continue;
      emitOperation({
        surfaceId,
        path,
        method,
        opDef,
        authIds,
        nodes,
        claims,
        edges,
      });
    }
  }

  return {
    extractor: input.extractor ?? OPENAPI3_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges,
  };
}

function parseDoc(bytes: Buffer, contentType: string): OpenApiDoc {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const text = bytes.toString("utf-8");
  const parsed = bare.includes("json") ? JSON.parse(text) : parseYaml(text);
  if (!isObject(parsed)) {
    throw new Error("extractOpenApi3: parsed doc is not an object");
  }
  return parsed as OpenApiDoc;
}

function pushSurfaceClaims(
  doc: OpenApiDoc,
  surfaceId: string,
  claims: ExtractedClaim[],
): void {
  if (doc.info?.version !== undefined) {
    claims.push({
      node_id: surfaceId,
      field: "version",
      value: doc.info.version,
      span_path: "$.info.version",
      confidence: "attested",
    });
  }
  const baseUrl = doc.servers?.[0]?.url;
  if (typeof baseUrl === "string") {
    claims.push({
      node_id: surfaceId,
      field: "base_url",
      value: baseUrl,
      span_path: "$.servers[0].url",
      confidence: "attested",
    });
  }
}

function emitAuthSchemes(
  doc: OpenApiDoc,
  productId: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
): Map<string, string> {
  const result = new Map<string, string>();
  const schemes = doc.components?.securitySchemes;
  if (schemes === undefined || !isObject(schemes)) return result;
  for (const [name, def] of Object.entries(schemes)) {
    if (!isObject(def)) continue;
    const id = stableId("ath", [productId, name]);
    result.set(name, id);
    nodes.push({ id, kind: "auth_scheme", parent_id: productId });
    pushAuthClaims(claims, id, name, def);
  }
  return result;
}

function pushAuthClaims(
  claims: ExtractedClaim[],
  id: string,
  name: string,
  def: Record<string, unknown>,
): void {
  const base = `$.components.securitySchemes["${name}"]`;
  claims.push({
    node_id: id,
    field: "type",
    value: normalizeAuthType(def),
    span_path: `${base}.type`,
    confidence: "attested",
  });
  if (typeof def.name === "string") {
    claims.push({
      node_id: id,
      field: "param_name",
      value: def.name,
      span_path: `${base}.name`,
      confidence: "attested",
    });
  }
  if (typeof def.in === "string") {
    claims.push({
      node_id: id,
      field: "location",
      value: def.in,
      span_path: `${base}.in`,
      confidence: "attested",
    });
  }
}

function normalizeAuthType(def: Record<string, unknown>): string {
  const type = typeof def.type === "string" ? def.type : "custom";
  if (type === "http") {
    const scheme = typeof def.scheme === "string" ? def.scheme : "";
    if (scheme === "bearer") return "bearer";
    if (scheme === "basic") return "basic";
    return "custom";
  }
  if (type === "apiKey") return "apiKey";
  if (type === "oauth2") return "oauth2";
  if (type === "mutualTLS") return "mutualTLS";
  return "custom";
}
