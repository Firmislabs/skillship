import { parse as parseYaml } from "yaml";
import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { isObject, stableId } from "./openapi3-util.js";

export const OPENREF_SDK_EXTRACTOR = "openref-sdk@1";

interface SdkDoc {
  readonly openref?: string;
  readonly info?: { id?: string; version?: string; language?: string };
  readonly functions?: unknown[];
}

export interface ExtractOpenrefSdkInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

export function extractOpenrefSdk(input: ExtractOpenrefSdkInput): Extraction {
  const doc = parseDoc(input.bytes);
  const nodes: ExtractedNode[] = [];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];
  const language =
    typeof doc.info?.language === "string" ? doc.info.language : "unknown";

  const surfaceId = stableId("sfc", [
    input.productId,
    "sdk",
    language,
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

  const fns = Array.isArray(doc.functions) ? doc.functions : [];
  fns.forEach((fn, i) => {
    if (!isObject(fn)) return;
    if (isBareRef(fn)) return;
    emitFunction({
      fn,
      surfaceId,
      language,
      spanBase: `$.functions[${i}]`,
      nodes,
      claims,
      edges,
    });
  });

  return {
    extractor: OPENREF_SDK_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges,
  };
}

function parseDoc(bytes: Buffer): SdkDoc {
  const parsed = parseYaml(bytes.toString("utf-8"));
  if (!isObject(parsed)) {
    throw new Error("extractOpenrefSdk: parsed doc is not an object");
  }
  return parsed as SdkDoc;
}

function isBareRef(fn: Record<string, unknown>): boolean {
  return typeof fn.$ref === "string" && fn.id === undefined;
}

interface EmitFnArgs {
  readonly fn: Record<string, unknown>;
  readonly surfaceId: string;
  readonly language: string;
  readonly spanBase: string;
  readonly nodes: ExtractedNode[];
  readonly claims: ExtractedClaim[];
  readonly edges: ExtractedEdge[];
}

function emitFunction(a: EmitFnArgs): void {
  const id = typeof a.fn.id === "string" ? a.fn.id : undefined;
  if (id === undefined) return;
  const title = typeof a.fn.title === "string" ? a.fn.title : id;
  const opId = stableId("op", [a.surfaceId, title, "sdk"]);
  a.nodes.push({ id: opId, kind: "operation", parent_id: a.surfaceId });
  a.edges.push({
    kind: "has_operation",
    from_node_id: a.surfaceId,
    to_node_id: opId,
  });
  pushFunctionClaims(a.claims, opId, a.fn, title, a.spanBase);
  emitSdkParams(opId, a.fn, a.spanBase, a.nodes, a.claims, a.edges);
  emitSdkExamples(opId, a.fn, a.language, a.spanBase, a.nodes, a.claims, a.edges);
}

function pushFunctionClaims(
  claims: ExtractedClaim[],
  opId: string,
  fn: Record<string, unknown>,
  title: string,
  spanBase: string,
): void {
  claims.push({
    node_id: opId,
    field: "method",
    value: "sdk",
    span_path: spanBase,
    confidence: "attested",
  });
  claims.push({
    node_id: opId,
    field: "path_or_name",
    value: title,
    span_path: `${spanBase}.title`,
    confidence: "attested",
  });
  if (typeof fn.summary === "string" && fn.summary.length > 0) {
    claims.push({
      node_id: opId,
      field: "summary",
      value: fn.summary,
      span_path: `${spanBase}.summary`,
      confidence: "attested",
    });
  }
  if (typeof fn.description === "string" && fn.description.length > 0) {
    claims.push({
      node_id: opId,
      field: "description",
      value: fn.description,
      span_path: `${spanBase}.description`,
      confidence: "attested",
    });
  }
}

function emitSdkParams(
  opId: string,
  fn: Record<string, unknown>,
  spanBase: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const params = fn.params;
  if (!Array.isArray(params)) return;
  params.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const name = typeof raw.name === "string" ? raw.name : undefined;
    if (name === undefined) return;
    const paramId = stableId("par", [opId, "positional", name]);
    const span = `${spanBase}.params[${i}]`;
    nodes.push({ id: paramId, kind: "parameter", parent_id: opId });
    edges.push({
      kind: "has_parameter",
      from_node_id: opId,
      to_node_id: paramId,
    });
    pushSdkParamClaims(claims, paramId, raw, name, span);
  });
}

function pushSdkParamClaims(
  claims: ExtractedClaim[],
  paramId: string,
  raw: Record<string, unknown>,
  name: string,
  span: string,
): void {
  claims.push({
    node_id: paramId,
    field: "name",
    value: name,
    span_path: `${span}.name`,
    confidence: "attested",
  });
  claims.push({
    node_id: paramId,
    field: "location",
    value: "positional",
    span_path: span,
    confidence: "attested",
  });
  const type = typeof raw.type === "string" ? raw.type : "unknown";
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
    value: raw.required === true,
    span_path: `${span}.required`,
    confidence: "attested",
  });
  if (typeof raw.description === "string" && raw.description.length > 0) {
    claims.push({
      node_id: paramId,
      field: "description",
      value: raw.description,
      span_path: `${span}.description`,
      confidence: "attested",
    });
  }
}

function emitSdkExamples(
  opId: string,
  fn: Record<string, unknown>,
  language: string,
  spanBase: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const examples = fn.examples;
  if (!Array.isArray(examples)) return;
  examples.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const code = typeof raw.code === "string" ? raw.code : undefined;
    if (code === undefined) return;
    const name = typeof raw.name === "string" ? raw.name : String(i);
    const exId = stableId("ex", [opId, language, name]);
    const span = `${spanBase}.examples[${i}]`;
    nodes.push({ id: exId, kind: "example", parent_id: opId });
    edges.push({
      kind: "illustrated_by",
      from_node_id: opId,
      to_node_id: exId,
    });
    claims.push({
      node_id: exId,
      field: "language",
      value: language,
      span_path: span,
      confidence: "attested",
    });
    claims.push({
      node_id: exId,
      field: "code",
      value: code,
      span_path: `${span}.code`,
      confidence: "attested",
    });
    if (typeof raw.narrative === "string" && raw.narrative.length > 0) {
      claims.push({
        node_id: exId,
        field: "narrative",
        value: raw.narrative,
        span_path: `${span}.narrative`,
        confidence: "attested",
      });
    }
  });
}
