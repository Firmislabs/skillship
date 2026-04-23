import { createHash } from "node:crypto";
import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { stableId } from "./openapi3-util.js";

export const DOCS_MD_EXTRACTOR = "docs-md@1";

const SUPPORTED_PREFIXES = ["text/markdown", "text/plain"];

export interface ExtractDocsMdInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

interface TitleInfo {
  readonly value: string;
  readonly fromH1: boolean;
}

export function extractDocsMd(input: ExtractDocsMdInput): Extraction {
  if (!isMarkdownContentType(input.source.content_type)) {
    return emptyResult(input.source.id);
  }
  const text = input.bytes.toString("utf-8");
  const title = chooseTitle(text, input.source.url);
  const pageId = stableId("dp", [input.productId, input.source.url]);
  const nodes: ExtractedNode[] = [
    { id: pageId, kind: "doc_page", parent_id: input.productId },
  ];
  const claims: ExtractedClaim[] = [
    {
      node_id: pageId,
      field: "url",
      value: input.source.url,
      span_path: "$.source.url",
      confidence: "attested",
    },
    {
      node_id: pageId,
      field: "title",
      value: title.value,
      span_path: title.fromH1 ? "$.h1" : "$.source.url",
      confidence: title.fromH1 ? "attested" : "derived",
    },
    {
      node_id: pageId,
      field: "content_hash",
      value: createHash("sha256").update(input.bytes).digest("hex"),
      span_path: "$",
      confidence: "attested",
    },
  ];
  const category = categoryFromUrl(input.source.url);
  if (category !== null) {
    claims.push({
      node_id: pageId,
      field: "category",
      value: category,
      span_path: "$.source.url",
      confidence: "derived",
    });
  }
  emitAuthSchemes(text, input.productId, input.source.url, nodes, claims);
  return {
    extractor: DOCS_MD_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges: [] as ExtractedEdge[],
  };
}

function emptyResult(sourceId: string): Extraction {
  return {
    extractor: DOCS_MD_EXTRACTOR,
    source_id: sourceId,
    nodes: [],
    claims: [],
    edges: [],
  };
}

function isMarkdownContentType(raw: string): boolean {
  const head = raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return SUPPORTED_PREFIXES.includes(head);
}

function chooseTitle(text: string, url: string): TitleInfo {
  for (const line of text.split("\n")) {
    const m = /^# (.+?)\s*$/.exec(line);
    if (m !== null && m[1] !== undefined) {
      return { value: m[1], fromH1: true };
    }
  }
  return { value: titleFromUrl(url), fromH1: false };
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter((p) => p.length > 0);
    return parts.length > 0 ? parts[parts.length - 1]! : u.hostname;
  } catch {
    return url;
  }
}

function categoryFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0]!;
    return parts.slice(0, -1).join("/");
  } catch {
    return null;
  }
}

// ── Auth heuristic ────────────────────────────────────────────────────────────

const AUTH_HEADING_RE =
  /^#{1,3}\s+.*(auth(entication|orization)?|oauth|api[\s-]?key|bearer|basic auth).*/im;

export type AuthSchemeType = "bearer" | "oauth2" | "apiKey" | "basic";

interface DetectedScheme {
  readonly type: AuthSchemeType;
  readonly paramName?: string | undefined;
  readonly location?: "header" | "query" | "cookie" | undefined;
  readonly scopes?: string[] | undefined;
  readonly matchedKeyword: string;
}

function emitAuthSchemes(
  text: string,
  productId: string,
  sourceUrl: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
): void {
  if (!AUTH_HEADING_RE.test(text)) return;
  const detected = detectSchemes(text);
  const seen = new Set<string>();
  for (const scheme of detected) {
    const id = stableId("ath", [productId, scheme.type, sourceUrl]);
    if (seen.has(id)) continue;
    seen.add(id);
    nodes.push({ id, kind: "auth_scheme", parent_id: productId });
    pushSchemeClaims(claims, id, scheme);
  }
}

function detectSchemes(text: string): DetectedScheme[] {
  const results: DetectedScheme[] = [];
  if (detectBearer(text)) {
    results.push({ type: "bearer", matchedKeyword: "bearer" });
  }
  const oauth2 = detectOAuth2(text);
  if (oauth2 !== null) results.push(oauth2);
  const apiKey = detectApiKey(text);
  if (apiKey !== null) results.push(apiKey);
  if (detectBasic(text)) {
    results.push({ type: "basic", matchedKeyword: "basic" });
  }
  return results;
}

function detectBearer(text: string): boolean {
  return (
    /Authorization:\s*Bearer/i.test(text) || /bearer\s+token/i.test(text)
  );
}

function detectBasic(text: string): boolean {
  return /Authorization:\s*Basic/i.test(text);
}

function detectOAuth2(text: string): DetectedScheme | null {
  if (!/oauth/i.test(text)) return null;
  if (!/\/oauth\/(authorize|token)/i.test(text)) return null;
  const scopes = extractOAuth2Scopes(text);
  return { type: "oauth2", matchedKeyword: "oauth", scopes };
}

function extractOAuth2Scopes(text: string): string[] {
  const SCOPE_RE = /^[\s*-]+`([a-zA-Z0-9:_.-]+)`/gm;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = SCOPE_RE.exec(text)) !== null) {
    const scope = m[1];
    if (scope === undefined || found.includes(scope)) continue;
    if (!isScopeLike(scope)) continue;
    found.push(scope);
    if (found.length >= 20) break;
  }
  return found;
}

function isScopeLike(token: string): boolean {
  if (token.length < 3) return false;
  if (!/[a-zA-Z]/.test(token)) return false;
  return true;
}

function detectApiKey(text: string): DetectedScheme | null {
  if (!/api[\s-]?key/i.test(text)) return null;
  // Match backtick-quoted header, raw header line in code block, or headers: key
  const hasHeader =
    /`[A-Za-z0-9_-]+:\s*(?:<[^>]+>|[A-Za-z0-9_-]+)`/.test(text) ||
    /^[A-Za-z0-9_-]{2,}:\s*\S+/m.test(text) ||
    /headers:/i.test(text);
  if (!hasHeader) return null;
  const paramName = extractApiKeyParamName(text);
  return {
    type: "apiKey",
    matchedKeyword: "api-key",
    paramName: paramName ?? undefined,
    location: "header",
  };
}

function extractApiKeyParamName(text: string): string | null {
  // Try backtick-quoted first (e.g. `X-API-Key: <value>`)
  const backtick = /`([A-Za-z0-9_-]+):\s*(?:<[^>]+>|[A-Za-z0-9_-]+)`/.exec(
    text,
  );
  if (backtick !== null && backtick[1] !== undefined) return backtick[1];
  // Fall back: raw header line matching api-key-like name (e.g. X-API-Key: ...)
  const raw = /^(X-API-Key|X-Api-Key|Api-Key|ApiKey)[:\s]/m.exec(text);
  if (raw !== null && raw[1] !== undefined) return raw[1];
  return null;
}

function pushSchemeClaims(
  claims: ExtractedClaim[],
  id: string,
  scheme: DetectedScheme,
): void {
  claims.push({
    node_id: id,
    field: "type",
    value: scheme.type,
    span_path: `$.body.matched["${scheme.matchedKeyword}"]`,
    confidence: "derived",
  });
  if (scheme.paramName !== undefined) {
    claims.push({
      node_id: id,
      field: "param_name",
      value: scheme.paramName,
      span_path: `$.body.matched["${scheme.matchedKeyword}"]`,
      confidence: "derived",
    });
  }
  if (scheme.location !== undefined) {
    claims.push({
      node_id: id,
      field: "location",
      value: scheme.location,
      span_path: `$.body.matched["${scheme.matchedKeyword}"]`,
      confidence: "derived",
    });
  }
  if (scheme.scopes !== undefined && scheme.scopes.length > 0) {
    claims.push({
      node_id: id,
      field: "scopes",
      value: scheme.scopes,
      span_path: `$.body.matched["${scheme.matchedKeyword}"]`,
      confidence: "derived",
    });
  }
}
