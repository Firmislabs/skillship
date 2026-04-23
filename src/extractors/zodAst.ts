import {
  CallExpression,
  Node,
  ObjectLiteralExpression,
  Project,
  StringLiteral,
  SyntaxKind,
} from "ts-morph";
import type { SourceNode } from "../graph/types.js";
import type {
  ExtractedClaim,
  ExtractedEdge,
  ExtractedNode,
  Extraction,
} from "./types.js";
import { stableId } from "./openapi3-util.js";
import { analyseZodChain } from "./zodAst-types.js";

export const ZOD_AST_EXTRACTOR = "zod-ast@1";

export interface ExtractZodAstInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

interface ToolLiteral {
  readonly varName: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ObjectLiteralExpression;
  readonly annotations: ObjectLiteralExpression;
}

const ANNOTATION_FIELD: Record<string, string> = {
  readOnlyHint: "is_read_only",
  destructiveHint: "is_destructive",
  idempotentHint: "is_idempotent",
  openWorldHint: "opens_world",
};

export function extractZodAst(input: ExtractZodAstInput): Extraction {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile(
    "input.ts",
    input.bytes.toString("utf-8"),
  );
  const tools = collectExportedTools(file);
  const surfaceId = stableId("srf", [input.productId, "mcp", "zod-ast"]);
  const nodes: ExtractedNode[] = [
    { id: surfaceId, kind: "surface", parent_id: input.productId },
  ];
  const claims: ExtractedClaim[] = [];
  const edges: ExtractedEdge[] = [];
  for (const tool of tools) {
    emitTool(tool, surfaceId, input.productId, nodes, claims, edges);
  }
  return {
    extractor: ZOD_AST_EXTRACTOR,
    source_id: input.source.id,
    nodes,
    claims,
    edges,
  };
}

function collectExportedTools(file: Node): ToolLiteral[] {
  const out: ToolLiteral[] = [];
  for (const stmt of file
    .asKindOrThrow(SyntaxKind.SourceFile)
    .getVariableStatements()) {
    if (!stmt.hasExportKeyword()) continue;
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!Node.isObjectLiteralExpression(init)) continue;
      const tool = readToolLiteral(decl.getName(), init);
      if (tool !== null) out.push(tool);
    }
  }
  return out;
}

function readToolLiteral(
  varName: string,
  obj: ObjectLiteralExpression,
): ToolLiteral | null {
  const name = readStringProp(obj, "name");
  const description = readStringProp(obj, "description");
  const inputSchema = readZodObjectArg(obj, "inputSchema");
  const annotations = readObjectProp(obj, "annotations");
  if (
    name === null ||
    description === null ||
    inputSchema === null ||
    annotations === null
  ) {
    return null;
  }
  return { varName, name, description, inputSchema, annotations };
}

function readStringProp(
  obj: ObjectLiteralExpression,
  key: string,
): string | null {
  const prop = obj.getProperty(key);
  if (!Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!Node.isStringLiteral(init) && !Node.isNoSubstitutionTemplateLiteral(init))
    return null;
  return (init as StringLiteral).getLiteralText();
}

function readObjectProp(
  obj: ObjectLiteralExpression,
  key: string,
): ObjectLiteralExpression | null {
  const prop = obj.getProperty(key);
  if (!Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  return Node.isObjectLiteralExpression(init) ? init : null;
}

function readZodObjectArg(
  obj: ObjectLiteralExpression,
  key: string,
): ObjectLiteralExpression | null {
  const prop = obj.getProperty(key);
  if (!Node.isPropertyAssignment(prop)) return null;
  const init = prop.getInitializer();
  if (!Node.isCallExpression(init)) return null;
  if (!isZObjectCall(init)) return null;
  const arg = init.getArguments()[0];
  return Node.isObjectLiteralExpression(arg) ? arg : null;
}

function isZObjectCall(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  return expr.getName() === "object";
}

function emitTool(
  tool: ToolLiteral,
  surfaceId: string,
  productId: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  const opId = stableId("op", [productId, "mcp", tool.name]);
  const exportPath = `$.exports["${tool.varName}"]`;
  nodes.push({ id: opId, kind: "operation", parent_id: surfaceId });
  edges.push({
    kind: "has_operation",
    from_node_id: surfaceId,
    to_node_id: opId,
  });
  claims.push(
    {
      node_id: opId,
      field: "method",
      value: "mcp",
      span_path: exportPath,
      confidence: "derived",
    },
    {
      node_id: opId,
      field: "path_or_name",
      value: tool.name,
      span_path: `${exportPath}.name`,
      confidence: "attested",
    },
    {
      node_id: opId,
      field: "summary",
      value: tool.description,
      span_path: `${exportPath}.description`,
      confidence: "attested",
    },
  );
  emitAnnotations(tool, opId, exportPath, claims);
  emitParameters(tool, opId, productId, exportPath, nodes, claims, edges);
}

function emitAnnotations(
  tool: ToolLiteral,
  opId: string,
  exportPath: string,
  claims: ExtractedClaim[],
): void {
  for (const prop of tool.annotations.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const key = prop.getName();
    const field = ANNOTATION_FIELD[key];
    if (field === undefined) continue;
    const init = prop.getInitializer();
    const value = readBooleanLiteral(init);
    if (value === null) continue;
    claims.push({
      node_id: opId,
      field,
      value,
      span_path: `${exportPath}.annotations.${key}`,
      confidence: "attested",
    });
  }
}

function readBooleanLiteral(init: Node | undefined): boolean | null {
  if (init === undefined) return null;
  if (init.getKind() === SyntaxKind.TrueKeyword) return true;
  if (init.getKind() === SyntaxKind.FalseKeyword) return false;
  return null;
}

function emitParameters(
  tool: ToolLiteral,
  opId: string,
  productId: string,
  exportPath: string,
  nodes: ExtractedNode[],
  claims: ExtractedClaim[],
  edges: ExtractedEdge[],
): void {
  for (const prop of tool.inputSchema.getProperties()) {
    if (!Node.isPropertyAssignment(prop)) continue;
    const propName = prop.getName();
    const init = prop.getInitializer();
    if (!Node.isCallExpression(init)) continue;
    const info = analyseZodChain(init);
    const paramId = stableId("prm", [productId, "mcp", tool.name, propName]);
    nodes.push({ id: paramId, kind: "parameter", parent_id: opId });
    edges.push({
      kind: "has_parameter",
      from_node_id: opId,
      to_node_id: paramId,
    });
    const paramPath = `${exportPath}.inputSchema.${propName}`;
    claims.push(
      {
        node_id: paramId,
        field: "name",
        value: propName,
        span_path: paramPath,
        confidence: "attested",
      },
      {
        node_id: paramId,
        field: "location",
        value: "body",
        span_path: paramPath,
        confidence: "derived",
      },
      {
        node_id: paramId,
        field: "type",
        value: info.type,
        span_path: paramPath,
        confidence: "attested",
      },
      {
        node_id: paramId,
        field: "required",
        value: info.required,
        span_path: paramPath,
        confidence: "attested",
      },
    );
  }
}

