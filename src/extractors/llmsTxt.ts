import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { stableId } from "./openapi3-util.js";

export const LLMS_TXT_EXTRACTOR = "llms-txt@1";

export interface ExtractLlmsTxtInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

interface LinkEntry {
  readonly heading: string;
  readonly title: string;
  readonly url: string;
  readonly indexInSection: number;
}

const H2_RE = /^##\s+(.+?)\s*$/;
const LINK_RE = /^-\s+\[(.+?)\]\((\S+?)\)(?::\s*(.+))?\s*$/;

export function extractLlmsTxt(input: ExtractLlmsTxtInput): Extraction {
  const text = input.bytes.toString("utf-8");
  const links = parseLinks(text);
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  for (const link of links) {
    emitLinkPage(link, input.productId, nodes, claims);
  }
  return {
    extractor: LLMS_TXT_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges: [] as ExtractedEdge[],
  };
}

function parseLinks(text: string): LinkEntry[] {
  const lines = text.split("\n");
  let heading: string | null = null;
  let indexInSection = 0;
  const out: LinkEntry[] = [];
  for (const line of lines) {
    const h2 = H2_RE.exec(line);
    if (h2 !== null) {
      heading = h2[1] ?? null;
      indexInSection = 0;
      continue;
    }
    if (heading === null) continue;
    const link = LINK_RE.exec(line);
    if (link === null) continue;
    const title = link[1];
    const url = link[2];
    if (title === undefined || url === undefined) continue;
    out.push({ heading, title, url, indexInSection });
    indexInSection += 1;
  }
  return out;
}

function emitLinkPage(
  link: LinkEntry,
  productId: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
): void {
  const pageId = stableId("dp", [productId, link.url]);
  const sectionPath = `$.sections["${link.heading}"]`;
  const linkPath = `${sectionPath}.links[${link.indexInSection}]`;
  nodes.push({ id: pageId, kind: "doc_page", parent_id: productId });
  claims.push({
    node_id: pageId,
    field: "url",
    value: link.url,
    span_path: `${linkPath}.url`,
    confidence: "attested",
  });
  claims.push({
    node_id: pageId,
    field: "title",
    value: link.title,
    span_path: `${linkPath}.title`,
    confidence: "attested",
  });
  claims.push({
    node_id: pageId,
    field: "category",
    value: link.heading,
    span_path: sectionPath,
    confidence: "derived",
  });
  claims.push({
    node_id: pageId,
    field: "tier",
    value: link.heading.toLowerCase() === "optional" ? "optional" : "core",
    span_path: sectionPath,
    confidence: "derived",
  });
}
