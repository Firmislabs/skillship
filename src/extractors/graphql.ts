import {
  parse,
  type DocumentNode,
  type FieldDefinitionNode,
  type InputValueDefinitionNode,
  type NamedTypeNode,
  type ListTypeNode,
  type NonNullTypeNode,
  type TypeNode,
} from "graphql"
import type { SourceNode } from "../graph/types.js"
import type {
  ExtractedClaim,
  ExtractedNode,
  Extraction,
} from "./types.js"
import { stableId } from "./openapi3-util.js"

export const GRAPHQL_EXTRACTOR = "graphql@1"

export interface ExtractGraphqlInput {
  readonly bytes: Buffer
  readonly source: SourceNode
  readonly productId: string
}

type GqlRootType = "QUERY" | "MUTATION" | "SUBSCRIPTION"

interface FieldEntry {
  readonly typeName: GqlRootType
  readonly field: FieldDefinitionNode
}

const ROOT_TYPE_MAP: Record<string, GqlRootType> = {
  Query: "QUERY",
  Mutation: "MUTATION",
  Subscription: "SUBSCRIPTION",
}

export async function extractGraphql(
  input: ExtractGraphqlInput,
): Promise<Extraction> {
  const text = input.bytes.toString("utf-8").trim()
  if (text.length === 0) return emptyResult(input.source.id)

  let doc: DocumentNode
  try {
    doc = parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return errorResult(input.source.id, msg)
  }

  const fields = collectRootFields(doc)
  if (fields.length === 0) return emptyResult(input.source.id)

  const surfaceId = stableId("srf", [input.productId, "graphql"])
  const surfaceNode: ExtractedNode = {
    id: surfaceId,
    kind: "surface",
    parent_id: input.productId,
  }

  const nodes: ExtractedNode[] = [surfaceNode]
  const claims: ExtractedClaim[] = []

  for (const entry of fields) {
    const opId = stableId("op", [
      input.productId,
      entry.typeName,
      entry.field.name.value,
    ])
    nodes.push({ id: opId, kind: "operation", parent_id: surfaceId })
    claims.push(...fieldClaims(opId, entry))
  }

  emitDefaultBearerAuth(input.productId, nodes, claims)

  return {
    extractor: GRAPHQL_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges: [],
  }
}

function collectRootFields(doc: DocumentNode): FieldEntry[] {
  const out: FieldEntry[] = []
  for (const def of doc.definitions) {
    if (
      def.kind !== "ObjectTypeDefinition" &&
      def.kind !== "ObjectTypeExtension"
    ) {
      continue
    }
    const rootType = ROOT_TYPE_MAP[def.name.value]
    if (rootType === undefined) continue
    for (const field of def.fields ?? []) {
      out.push({ typeName: rootType, field })
    }
  }
  return out
}

function fieldClaims(
  opId: string,
  entry: FieldEntry,
): ExtractedClaim[] {
  const { typeName, field } = entry
  const out: ExtractedClaim[] = []

  out.push(attested(opId, "method", typeName, `$.${field.name.value}`))
  out.push(attested(opId, "path_or_name", field.name.value, `$.${field.name.value}`))
  out.push(attested(opId, "returns", printType(field.type), `$.${field.name.value}.type`))

  const description = field.description?.value?.trim()
  if (description) {
    out.push(attested(opId, "summary", description, `$.${field.name.value}.description`))
  }

  const args = field.arguments ?? []
  if (args.length > 0) {
    const params = args.map(printArg)
    out.push(attested(opId, "params", params, `$.${field.name.value}.arguments`))
  }

  return out
}

function attested(
  nodeId: string,
  field: string,
  value: unknown,
  spanPath: string,
): ExtractedClaim {
  return { node_id: nodeId, field, value, span_path: spanPath, confidence: "attested" }
}

function printType(t: TypeNode): string {
  if (t.kind === "NamedType") return (t as NamedTypeNode).name.value
  if (t.kind === "NonNullType") return `${printType((t as NonNullTypeNode).type)}!`
  if (t.kind === "ListType") return `[${printType((t as ListTypeNode).type)}]`
  return ""
}

function printArg(arg: InputValueDefinitionNode): string {
  const base = `${arg.name.value}: ${printType(arg.type)}`
  const desc = arg.description?.value?.trim()
  return desc !== undefined && desc.length > 0 ? `${base} — ${desc}` : base
}

function emitDefaultBearerAuth(
  productId: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
): void {
  const id = stableId("ath", [productId, "graphql-default"])
  nodes.push({ id, kind: "auth_scheme", parent_id: productId })
  claims.push({
    node_id: id,
    field: "type",
    value: "bearer",
    span_path: "$.synthesized",
    confidence: "inferred",
  })
}

function emptyResult(sourceId: string): Extraction {
  return { extractor: GRAPHQL_EXTRACTOR, source_id: sourceId, nodes: [], claims: [], edges: [] }
}

function errorResult(sourceId: string, message: string): Extraction {
  return {
    extractor: GRAPHQL_EXTRACTOR,
    source_id: sourceId,
    nodes: [],
    claims: [
      {
        node_id: sourceId,
        field: "extraction_error",
        value: message,
        span_path: "$",
        confidence: "attested",
      },
    ],
    edges: [],
  }
}
