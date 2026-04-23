import { parse as parseYaml } from "yaml";
import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { isObject, stableId } from "./openapi3-util.js";

export const OPENREF_CLI_EXTRACTOR = "openref-cli@1";

interface CliDoc {
  readonly clispec?: string;
  readonly info?: { id?: string; version?: string; title?: string };
  readonly commands?: unknown[];
}

interface CliFlag {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

export interface ExtractOpenrefCliInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

export function extractOpenrefCli(input: ExtractOpenrefCliInput): Extraction {
  const doc = parseDoc(input.bytes);
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];

  const surfaceId = stableId("sfc", [
    input.productId,
    "cli",
    doc.info?.version ?? "",
  ]);
  nodes.push({ id: surfaceId, kind: "surface", parent_id: input.productId });
  edges.push({
    kind: "exposes",
    from_node_id: input.productId,
    to_node_id: surfaceId,
  });
  if (doc.info?.version !== undefined) {
    claims.push({
      node_id: surfaceId,
      field: "version",
      value: doc.info.version,
      span_path: "$.info.version",
      confidence: "attested",
    });
  }

  const cmds = Array.isArray(doc.commands) ? doc.commands : [];
  cmds.forEach((cmd, i) => {
    walkCommand({
      raw: cmd,
      parents: [],
      pathToHere: `$.commands[${i}]`,
      surfaceId,
      nodes,
      claims,
      edges,
    });
  });

  return {
    extractor: OPENREF_CLI_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges,
  };
}

function parseDoc(bytes: Buffer): CliDoc {
  const parsed = parseYaml(bytes.toString("utf-8"));
  if (!isObject(parsed)) {
    throw new Error("extractOpenrefCli: parsed doc is not an object");
  }
  return parsed as CliDoc;
}

interface WalkArgs {
  readonly raw: unknown;
  readonly parents: string[];
  readonly pathToHere: string;
  readonly surfaceId: string;
  readonly nodes: ExtractedNode[];
  readonly claims: ExtractedClaim[];
  readonly edges: ExtractedEdge[];
}

function walkCommand(a: WalkArgs): void {
  if (!isObject(a.raw)) return;
  const id = typeof a.raw.id === "string" ? a.raw.id : undefined;
  if (id === undefined) return;
  const chain = [...a.parents, id];
  const pathOrName = chain.join(" ");
  const opId = stableId("op", [a.surfaceId, pathOrName, "cli"]);

  a.nodes.push({ id: opId, kind: "operation", parent_id: a.surfaceId });
  a.edges.push({
    kind: "has_operation",
    from_node_id: a.surfaceId,
    to_node_id: opId,
  });
  pushCommandClaims(a.claims, opId, a.raw, pathOrName, a.pathToHere);
  emitFlags(opId, a.raw, a.pathToHere, a.nodes, a.claims, a.edges);

  const subs = a.raw.subcommands;
  if (!Array.isArray(subs)) return;
  subs.forEach((s, i) => {
    walkCommand({
      raw: s,
      parents: chain,
      pathToHere: `${a.pathToHere}.subcommands[${i}]`,
      surfaceId: a.surfaceId,
      nodes: a.nodes,
      claims: a.claims,
      edges: a.edges,
    });
  });
}

function pushCommandClaims(
  claims: ExtractedClaim[],
  opId: string,
  raw: Record<string, unknown>,
  pathOrName: string,
  spanBase: string,
): void {
  claims.push({
    node_id: opId,
    field: "method",
    value: "cli",
    span_path: spanBase,
    confidence: "attested",
  });
  claims.push({
    node_id: opId,
    field: "path_or_name",
    value: pathOrName,
    span_path: `${spanBase}.id`,
    confidence: "attested",
  });
  if (typeof raw.summary === "string" && raw.summary.length > 0) {
    claims.push({
      node_id: opId,
      field: "summary",
      value: raw.summary,
      span_path: `${spanBase}.summary`,
      confidence: "attested",
    });
  }
  if (typeof raw.description === "string" && raw.description.length > 0) {
    claims.push({
      node_id: opId,
      field: "description",
      value: raw.description,
      span_path: `${spanBase}.description`,
      confidence: "attested",
    });
  }
}

function emitFlags(
  opId: string,
  raw: Record<string, unknown>,
  spanBase: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const flags = raw.flags;
  if (!Array.isArray(flags)) return;
  flags.forEach((f, i) => {
    if (!isObject(f)) return;
    const id = typeof f.id === "string" ? f.id : undefined;
    if (id === undefined) return;
    pushFlag(
      { id, raw: f },
      opId,
      `${spanBase}.flags[${i}]`,
      nodes,
      claims,
      edges,
    );
  });
}

function pushFlag(
  flag: CliFlag,
  opId: string,
  span: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const paramId = stableId("par", [opId, "flag", flag.id]);
  nodes.push({ id: paramId, kind: "parameter", parent_id: opId });
  edges.push({
    kind: "has_parameter",
    from_node_id: opId,
    to_node_id: paramId,
  });
  claims.push({
    node_id: paramId,
    field: "name",
    value: flag.id,
    span_path: `${span}.id`,
    confidence: "attested",
  });
  claims.push({
    node_id: paramId,
    field: "location",
    value: "flag",
    span_path: span,
    confidence: "attested",
  });
  const type = typeof flag.raw.type === "string" ? flag.raw.type : "string";
  claims.push({
    node_id: paramId,
    field: "type",
    value: type,
    span_path: `${span}.type`,
    confidence: "attested",
  });
  claims.push({
    node_id: paramId,
    field: "required",
    value: flag.raw.required === true,
    span_path: `${span}.required`,
    confidence: "attested",
  });
  if (
    typeof flag.raw.default_value === "string" ||
    typeof flag.raw.default_value === "number" ||
    typeof flag.raw.default_value === "boolean"
  ) {
    claims.push({
      node_id: paramId,
      field: "default",
      value: flag.raw.default_value,
      span_path: `${span}.default_value`,
      confidence: "attested",
    });
  }
  if (typeof flag.raw.description === "string" && flag.raw.description.length > 0) {
    claims.push({
      node_id: paramId,
      field: "description",
      value: flag.raw.description,
      span_path: `${span}.description`,
      confidence: "attested",
    });
  }
}
