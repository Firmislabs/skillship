import type { SourceNode } from "../graph/types.js";
import type { Extraction } from "./types.js";
import {
  extractOpenApi3Doc,
  type OpenApiDoc,
} from "./openapi3.js";
import { isObject } from "./openapi3-util.js";

export const SWAGGER2_EXTRACTOR = "swagger@2";

export interface ExtractSwagger2Input {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

export function extractSwagger2(input: ExtractSwagger2Input): Extraction {
  const doc = JSON.parse(input.bytes.toString("utf-8"));
  if (!isObject(doc)) {
    throw new Error("extractSwagger2: parsed doc is not an object");
  }
  const converted = convertSwagger2ToOpenapi3(doc);
  return extractOpenApi3Doc({
    doc: converted,
    source: input.source,
    productId: input.productId,
    extractor: SWAGGER2_EXTRACTOR,
  });
}

export function convertSwagger2ToOpenapi3(
  inDoc: Record<string, unknown>,
): OpenApiDoc {
  const doc = deepClone(inDoc);
  delete doc.swagger;
  const out: Record<string, unknown> = {
    openapi: "3.0.0",
    info: doc.info,
    servers: buildServers(doc),
    paths: convertPaths(doc),
    components: buildComponents(doc),
  };
  rewriteRefsInPlace(out);
  return out as OpenApiDoc;
}

function buildServers(
  doc: Record<string, unknown>,
): { url: string }[] | undefined {
  const host = typeof doc.host === "string" ? doc.host : undefined;
  const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
  const schemes = Array.isArray(doc.schemes)
    ? (doc.schemes as unknown[]).filter((s): s is string => typeof s === "string")
    : ["https"];
  if (host === undefined) return undefined;
  return schemes.map((scheme) => ({ url: `${scheme}://${host}${basePath}` }));
}

function convertPaths(
  doc: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const defaultConsumes = toStringArray(doc.consumes) ?? ["application/json"];
  const defaultProduces = toStringArray(doc.produces) ?? ["application/json"];
  const paths = isObject(doc.paths) ? doc.paths : {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isObject(pathItem)) continue;
    result[path] = convertPathItem(pathItem, defaultConsumes, defaultProduces);
  }
  return result;
}

function convertPathItem(
  pathItem: Record<string, unknown>,
  defaultConsumes: string[],
  defaultProduces: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pathItem)) {
    if (!isObject(value)) {
      out[key] = value;
      continue;
    }
    if (isHttpMethod(key)) {
      out[key] = convertOperation(value, defaultConsumes, defaultProduces);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function convertOperation(
  op: Record<string, unknown>,
  defaultConsumes: string[],
  defaultProduces: string[],
): Record<string, unknown> {
  const consumes = toStringArray(op.consumes) ?? defaultConsumes;
  const produces = toStringArray(op.produces) ?? defaultProduces;
  const { body, rest } = splitParameters(op.parameters);
  const out: Record<string, unknown> = { ...op };
  delete out.consumes;
  delete out.produces;
  out.parameters = rest.map(convertNonBodyParam);
  if (body !== undefined) {
    out.requestBody = {
      required: body.required === true,
      content: contentFromSchema(consumes, body.schema),
    };
  }
  out.responses = convertResponses(op.responses, produces);
  return out;
}

function splitParameters(raw: unknown): {
  body: Record<string, unknown> | undefined;
  rest: Record<string, unknown>[];
} {
  if (!Array.isArray(raw)) return { body: undefined, rest: [] };
  const rest: Record<string, unknown>[] = [];
  let body: Record<string, unknown> | undefined;
  for (const p of raw) {
    if (!isObject(p)) continue;
    if (p.in === "body") {
      body = p;
    } else {
      rest.push(p);
    }
  }
  return { body, rest };
}

function convertNonBodyParam(
  p: Record<string, unknown>,
): Record<string, unknown> {
  if (p.schema !== undefined) return p;
  const schema: Record<string, unknown> = {};
  for (const key of ["type", "format", "items", "enum", "default", "minimum", "maximum"]) {
    if (p[key] !== undefined) schema[key] = p[key];
  }
  const { type, format, items, enum: enm, default: def, minimum, maximum, ...rest } = p;
  void type;
  void format;
  void items;
  void enm;
  void def;
  void minimum;
  void maximum;
  return { ...rest, schema };
}

function convertResponses(
  raw: unknown,
  produces: string[],
): Record<string, unknown> {
  if (!isObject(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [code, respRaw] of Object.entries(raw)) {
    if (!isObject(respRaw)) {
      out[code] = respRaw;
      continue;
    }
    const resp: Record<string, unknown> = { ...respRaw };
    if (respRaw.schema !== undefined) {
      resp.content = contentFromSchema(produces, respRaw.schema);
      delete resp.schema;
    }
    out[code] = resp;
  }
  return out;
}

function contentFromSchema(
  mediaTypes: string[],
  schema: unknown,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const mt of mediaTypes) result[mt] = { schema };
  return result;
}

function buildComponents(
  doc: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const schemas = isObject(doc.definitions) ? doc.definitions : undefined;
  const securitySchemes = convertSecuritySchemes(doc.securityDefinitions);
  if (schemas === undefined && securitySchemes === undefined) return undefined;
  const out: Record<string, unknown> = {};
  if (schemas !== undefined) out.schemas = schemas;
  if (securitySchemes !== undefined) out.securitySchemes = securitySchemes;
  return out;
}

function convertSecuritySchemes(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [name, defRaw] of Object.entries(raw)) {
    if (!isObject(defRaw)) continue;
    out[name] = convertSecurityScheme(defRaw);
  }
  return out;
}

function convertSecurityScheme(
  def: Record<string, unknown>,
): Record<string, unknown> {
  const type = def.type;
  if (type === "basic") return { type: "http", scheme: "basic" };
  if (type === "apiKey") {
    const out: Record<string, unknown> = { type: "apiKey" };
    if (typeof def.name === "string") out.name = def.name;
    if (typeof def.in === "string") out.in = def.in;
    return out;
  }
  if (type === "oauth2") {
    return { type: "oauth2", flows: flowsFromSwagger2(def) };
  }
  return def;
}

function flowsFromSwagger2(
  def: Record<string, unknown>,
): Record<string, unknown> {
  const flow = typeof def.flow === "string" ? def.flow : "implicit";
  const mapping: Record<string, string> = {
    implicit: "implicit",
    password: "password",
    application: "clientCredentials",
    accessCode: "authorizationCode",
  };
  const flow3 = mapping[flow] ?? "implicit";
  const body: Record<string, unknown> = {};
  if (typeof def.authorizationUrl === "string") {
    body.authorizationUrl = def.authorizationUrl;
  }
  if (typeof def.tokenUrl === "string") body.tokenUrl = def.tokenUrl;
  body.scopes = isObject(def.scopes) ? def.scopes : {};
  return { [flow3]: body };
}

function rewriteRefsInPlace(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) rewriteRefsInPlace(item);
    return;
  }
  if (!isObject(node)) return;
  for (const [k, v] of Object.entries(node)) {
    if (
      k === "$ref" &&
      typeof v === "string" &&
      v.startsWith("#/definitions/")
    ) {
      (node as Record<string, unknown>)[k] = v.replace(
        "#/definitions/",
        "#/components/schemas/",
      );
    } else {
      rewriteRefsInPlace(v);
    }
  }
}

function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

function isHttpMethod(s: string): boolean {
  return [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
  ].includes(s);
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
