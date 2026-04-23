import type {
  ClaimConfidence,
  EdgeKind,
  NodeKind,
} from "../graph/types.js";

export interface ExtractedNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly parent_id: string | null;
}

export interface ExtractedClaim {
  readonly node_id: string;
  readonly field: string;
  readonly value: unknown;
  readonly span_path?: string;
  readonly span_start?: number;
  readonly span_end?: number;
  readonly confidence: ClaimConfidence;
}

export interface ExtractedEdge {
  readonly kind: EdgeKind;
  readonly from_node_id: string;
  readonly to_node_id: string;
  readonly rationale?: string;
}

export interface Extraction {
  readonly extractor: string;
  readonly source_id: string;
  readonly nodes: ExtractedNode[];
  readonly claims: ExtractedClaim[];
  readonly edges: ExtractedEdge[];
}
