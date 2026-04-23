import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { isObject, stableId } from "./openapi3-util.js";

export const MCP_WELL_KNOWN_EXTRACTOR = "mcp-well-known@1";

export interface ExtractMcpWellKnownInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

interface Parsed {
  readonly resource?: string;
  readonly authorization_servers?: unknown[];
  readonly scopes_supported?: unknown[];
  readonly bearer_methods_supported?: unknown[];
}

export function extractMcpWellKnown(
  input: ExtractMcpWellKnownInput,
): Extraction {
  const parsed = safeParse(input.bytes);
  if (parsed === null) return emptyResult(input.source.id);
  const surfaceId = stableId("srf", [input.productId, "mcp"]);
  const authId = stableId("auth", [input.productId, "oauth2", "mcp"]);
  const nodes: ExtractedNode[] = [
    { id: surfaceId, kind: "surface", parent_id: input.productId },
    { id: authId, kind: "auth_scheme", parent_id: input.productId },
  ];
  const claims: ExtractedClaim[] = [
    ...surfaceClaims(surfaceId, parsed, input.source.url),
    ...authClaims(authId, parsed),
  ];
  const edges: ExtractedEdge[] = [
    {
      kind: "auth_requires",
      from_node_id: surfaceId,
      to_node_id: authId,
      rationale: "MCP /.well-known declares oauth2 protection",
    },
  ];
  return {
    extractor: MCP_WELL_KNOWN_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges,
  };
}

function emptyResult(sourceId: string): Extraction {
  return {
    extractor: MCP_WELL_KNOWN_EXTRACTOR,
    source_id: sourceId,
    nodes: [],
    claims: [],
    edges: [],
  };
}

function safeParse(bytes: Buffer): Parsed | null {
  try {
    const raw = JSON.parse(bytes.toString("utf-8")) as unknown;
    if (!isObject(raw)) return null;
    const out: Parsed = {};
    if (typeof raw.resource === "string") {
      Object.assign(out, { resource: raw.resource });
    }
    if (Array.isArray(raw.authorization_servers)) {
      Object.assign(out, { authorization_servers: raw.authorization_servers });
    }
    if (Array.isArray(raw.scopes_supported)) {
      Object.assign(out, { scopes_supported: raw.scopes_supported });
    }
    if (Array.isArray(raw.bearer_methods_supported)) {
      Object.assign(out, {
        bearer_methods_supported: raw.bearer_methods_supported,
      });
    }
    return out;
  } catch {
    return null;
  }
}

function surfaceClaims(
  surfaceId: string,
  parsed: Parsed,
  sourceUrl: string,
): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  if (parsed.resource !== undefined) {
    out.push({
      node_id: surfaceId,
      field: "base_url",
      value: parsed.resource,
      span_path: "$.resource",
      confidence: "attested",
    });
  }
  out.push({
    node_id: surfaceId,
    field: "spec_url",
    value: sourceUrl,
    span_path: "$",
    confidence: "derived",
  });
  return out;
}

function authClaims(authId: string, parsed: Parsed): ExtractedClaim[] {
  const out: ExtractedClaim[] = [];
  out.push({
    node_id: authId,
    field: "type",
    value: "oauth2",
    span_path: "$",
    confidence: "derived",
  });
  const flows: Record<string, unknown[]> = {};
  if (parsed.authorization_servers !== undefined) {
    flows.authorization_servers = parsed.authorization_servers;
    out.push({
      node_id: authId,
      field: "authorization_servers",
      value: parsed.authorization_servers,
      span_path: "$.authorization_servers",
      confidence: "attested",
    });
  }
  if (parsed.scopes_supported !== undefined) {
    flows.scopes = parsed.scopes_supported;
    out.push({
      node_id: authId,
      field: "scopes_supported",
      value: parsed.scopes_supported,
      span_path: "$.scopes_supported",
      confidence: "attested",
    });
  }
  if (parsed.bearer_methods_supported !== undefined) {
    flows.bearer_methods = parsed.bearer_methods_supported;
    out.push({
      node_id: authId,
      field: "bearer_methods_supported",
      value: parsed.bearer_methods_supported,
      span_path: "$.bearer_methods_supported",
      confidence: "attested",
    });
  }
  out.push({
    node_id: authId,
    field: "flows",
    value: flows,
    span_path: "$",
    confidence: "attested",
  });
  return out;
}
