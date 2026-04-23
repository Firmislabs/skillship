import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
} from "./types.js";
import { isObject, stableId } from "./openapi3-util.js";

export interface EmitOperationArgs {
  readonly surfaceId: string;
  readonly path: string;
  readonly method: string;
  readonly opDef: Record<string, unknown>;
  readonly authIds: Map<string, string>;
  readonly nodes: ExtractedNode[];
  readonly claims: ExtractedClaim[];
  readonly edges: ExtractedEdge[];
}

export function emitOperation(a: EmitOperationArgs): void {
  const opId = stableId("op", [a.surfaceId, a.path, a.method]);
  const methodUpper = a.method.toUpperCase();
  const base = `$.paths["${a.path}"].${a.method}`;

  a.nodes.push({ id: opId, kind: "operation", parent_id: a.surfaceId });
  a.edges.push({
    kind: "has_operation",
    from_node_id: a.surfaceId,
    to_node_id: opId,
  });
  a.claims.push({
    node_id: opId,
    field: "method",
    value: methodUpper,
    span_path: base,
    confidence: "attested",
  });
  a.claims.push({
    node_id: opId,
    field: "path_or_name",
    value: a.path,
    span_path: base,
    confidence: "attested",
  });

  pushStringClaim(a.claims, opId, a.opDef, "summary", `${base}.summary`);
  pushStringClaim(
    a.claims,
    opId,
    a.opDef,
    "description",
    `${base}.description`,
  );
  pushBoolClaim(a.claims, opId, a.opDef, "deprecated", `${base}.deprecated`);

  if (a.method === "get" || a.method === "head" || a.method === "options") {
    a.claims.push({
      node_id: opId,
      field: "is_read_only",
      value: true,
      span_path: base,
      confidence: "derived",
    });
  }

  emitParameters(opId, a.opDef, base, a.nodes, a.claims, a.edges);
  emitResponses(opId, a.opDef, base, a.nodes, a.claims, a.edges);
  emitOperationAuth(opId, a.opDef, base, a.authIds, a.edges);
}

function pushStringClaim(
  claims: ExtractedClaim[],
  nodeId: string,
  obj: Record<string, unknown>,
  field: string,
  spanPath: string,
): void {
  const v = obj[field];
  if (typeof v === "string" && v.length > 0) {
    claims.push({
      node_id: nodeId,
      field,
      value: v,
      span_path: spanPath,
      confidence: "attested",
    });
  }
}

function pushBoolClaim(
  claims: ExtractedClaim[],
  nodeId: string,
  obj: Record<string, unknown>,
  field: string,
  spanPath: string,
): void {
  const v = obj[field];
  if (typeof v === "boolean") {
    claims.push({
      node_id: nodeId,
      field,
      value: v,
      span_path: spanPath,
      confidence: "attested",
    });
  }
}

function emitParameters(
  opId: string,
  opDef: Record<string, unknown>,
  base: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const params = opDef.parameters;
  if (!Array.isArray(params)) return;
  params.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const name = typeof raw.name === "string" ? raw.name : undefined;
    const location = typeof raw.in === "string" ? raw.in : undefined;
    if (name === undefined || location === undefined) return;
    const paramId = stableId("par", [opId, location, name]);
    const paramBase = `${base}.parameters[${i}]`;
    nodes.push({ id: paramId, kind: "parameter", parent_id: opId });
    edges.push({
      kind: "has_parameter",
      from_node_id: opId,
      to_node_id: paramId,
    });
    pushParamClaims(claims, paramId, raw, paramBase, name, location);
  });
}

function pushParamClaims(
  claims: ExtractedClaim[],
  paramId: string,
  raw: Record<string, unknown>,
  paramBase: string,
  name: string,
  location: string,
): void {
  claims.push({
    node_id: paramId,
    field: "name",
    value: name,
    span_path: `${paramBase}.name`,
    confidence: "attested",
  });
  claims.push({
    node_id: paramId,
    field: "location",
    value: location,
    span_path: `${paramBase}.in`,
    confidence: "attested",
  });
  claims.push({
    node_id: paramId,
    field: "required",
    value: raw.required === true,
    span_path: `${paramBase}.required`,
    confidence: "attested",
  });
  const schema = isObject(raw.schema) ? raw.schema : undefined;
  const type = typeof schema?.type === "string" ? schema.type : "unknown";
  claims.push({
    node_id: paramId,
    field: "type",
    value: type,
    span_path: `${paramBase}.schema.type`,
    confidence: "attested",
  });
  if (typeof raw.description === "string" && raw.description.length > 0) {
    claims.push({
      node_id: paramId,
      field: "description",
      value: raw.description,
      span_path: `${paramBase}.description`,
      confidence: "attested",
    });
  }
}

function emitResponses(
  opId: string,
  opDef: Record<string, unknown>,
  base: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const responses = isObject(opDef.responses) ? opDef.responses : undefined;
  if (responses === undefined) return;
  for (const [status, respDef] of Object.entries(responses)) {
    if (!isObject(respDef)) continue;
    const statusNum = Number(status);
    const statusKey = Number.isFinite(statusNum) ? statusNum : status;
    const content = isObject(respDef.content) ? respDef.content : undefined;
    const contentTypes = content ? Object.keys(content) : ["*/*"];
    for (const ct of contentTypes) {
      const respId = stableId("rsp", [opId, String(statusKey), ct]);
      const respBase = `${base}.responses["${status}"]`;
      nodes.push({ id: respId, kind: "response_shape", parent_id: opId });
      edges.push({
        kind: "returns",
        from_node_id: opId,
        to_node_id: respId,
      });
      pushResponseClaims(claims, respId, respBase, statusKey, ct, content);
    }
  }
}

function pushResponseClaims(
  claims: ExtractedClaim[],
  respId: string,
  respBase: string,
  statusKey: number | string,
  ct: string,
  content: Record<string, unknown> | undefined,
): void {
  claims.push({
    node_id: respId,
    field: "status_code",
    value: statusKey,
    span_path: respBase,
    confidence: "attested",
  });
  claims.push({
    node_id: respId,
    field: "content_type",
    value: ct,
    span_path: `${respBase}.content["${ct}"]`,
    confidence: "attested",
  });
  const ctBody = content !== undefined && isObject(content[ct])
    ? content[ct]
    : undefined;
  const schema = ctBody !== undefined && isObject(ctBody.schema)
    ? ctBody.schema
    : undefined;
  const ref = schema !== undefined && typeof schema.$ref === "string"
    ? schema.$ref
    : undefined;
  if (ref !== undefined) {
    claims.push({
      node_id: respId,
      field: "schema_ref",
      value: ref,
      span_path: `${respBase}.content["${ct}"].schema.$ref`,
      confidence: "attested",
    });
  }
}

function emitOperationAuth(
  opId: string,
  opDef: Record<string, unknown>,
  base: string,
  authIds: Map<string, string>,
  edges: ExtractedEdge[],
): void {
  const security = opDef.security;
  if (!Array.isArray(security)) return;
  for (const req of security) {
    if (!isObject(req)) continue;
    for (const name of Object.keys(req)) {
      const authId = authIds.get(name);
      if (authId === undefined) continue;
      edges.push({
        kind: "auth_requires",
        from_node_id: opId,
        to_node_id: authId,
        rationale: `${base}.security`,
      });
    }
  }
}
