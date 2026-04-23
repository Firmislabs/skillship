import { parseStringPromise } from "xml2js";
import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { stableId } from "./openapi3-util.js";

export const SITEMAP_EXTRACTOR = "sitemap@1";

export interface ExtractSitemapInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

interface UrlEntry {
  readonly loc: string;
  readonly lastmod?: string;
}

export async function extractSitemap(
  input: ExtractSitemapInput,
): Promise<Extraction> {
  const parsed = await parseStringPromise(input.bytes.toString("utf-8"), {
    explicitArray: false,
    trim: true,
  });
  const entries = extractUrlEntries(parsed);
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];

  entries.forEach((entry, i) => {
    emitDocPage(entry, i, input.productId, nodes, claims, edges);
  });

  return {
    extractor: SITEMAP_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges,
  };
}

function extractUrlEntries(parsed: unknown): UrlEntry[] {
  if (parsed === null || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  if (!("urlset" in root)) return [];
  const urlset = root.urlset;
  if (urlset === null || typeof urlset !== "object") return [];
  const urls = (urlset as Record<string, unknown>).url;
  if (urls === undefined) return [];
  const arr = Array.isArray(urls) ? urls : [urls];
  const out: UrlEntry[] = [];
  for (const raw of arr) {
    if (raw === null || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    const loc = typeof rec.loc === "string" ? rec.loc : undefined;
    if (loc === undefined) continue;
    const lastmod =
      typeof rec.lastmod === "string" ? rec.lastmod : undefined;
    out.push({ loc, ...(lastmod !== undefined ? { lastmod } : {}) });
  }
  return out;
}

function emitDocPage(
  entry: UrlEntry,
  i: number,
  productId: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  _edges: ExtractedEdge[],
): void {
  const pageId = stableId("dp", [productId, entry.loc]);
  const span = `//urlset/url[${i + 1}]`;
  nodes.push({ id: pageId, kind: "doc_page", parent_id: productId });
  claims.push({
    node_id: pageId,
    field: "url",
    value: entry.loc,
    span_path: `${span}/loc`,
    confidence: "attested",
  });
  const title = titleFromUrl(entry.loc);
  claims.push({
    node_id: pageId,
    field: "title",
    value: title,
    span_path: `${span}/loc`,
    confidence: "derived",
  });
  if (entry.lastmod !== undefined) {
    claims.push({
      node_id: pageId,
      field: "last_modified",
      value: entry.lastmod,
      span_path: `${span}/lastmod`,
      confidence: "attested",
    });
  }
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
