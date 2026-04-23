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
