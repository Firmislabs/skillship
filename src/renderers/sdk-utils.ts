// src/renderers/sdk-utils.ts
// OAS extraction helpers for sdk.ts.
// Kept separate to stay under the 300-line file cap while sdk.ts accumulates
// correctness fixes (EXDEV fallback, collision guards, slug validation, etc.).

import type { AuthSchemeDescriptor } from "../sdk-plugins/runtime.js";
import type { OperationInfo } from "../sdk-plugins/resource-tree.js";

// ---- Minimal OAS doc shape (read-only, subset used by extractors) ----

interface OasSecurityScheme {
  readonly type?: string;
  readonly scheme?: string;
  readonly in?: string;
  readonly name?: string;
}
interface OasComponents {
  readonly securitySchemes?: Record<string, OasSecurityScheme>;
}
interface OasOperation {
  readonly operationId?: string;
  readonly tags?: readonly string[];
}
type OasPathItem = Record<string, OasOperation>;
interface OasDoc {
  readonly components?: OasComponents;
  readonly paths?: Record<string, OasPathItem>;
}

// ---- Auth scheme extraction ----

/**
 * Parses the OAS doc and returns a descriptor per security scheme.
 * Throws for unsupported scheme types (oauth2, openIdConnect, mutualTLS).
 * Supported: http+bearer, http+basic, apiKey.
 */
export function extractAuthSchemes(oasJson: string): readonly AuthSchemeDescriptor[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const schemes = doc.components?.securitySchemes ?? {};
  const out: AuthSchemeDescriptor[] = [];
  for (const id of Object.keys(schemes).sort()) {
    const s = schemes[id]!;
    const type = s.type ?? "";
    const scheme = s.scheme ?? "";
    if (type === "http" && scheme === "bearer") {
      out.push({ kind: "bearer", id });
    } else if (type === "http" && scheme === "basic") {
      out.push({ kind: "basic", id });
    } else if (type === "apiKey") {
      const loc: "header" | "query" = s.in === "query" ? "query" : "header";
      const name = typeof s.name === "string" ? s.name : "Authorization";
      out.push({ kind: "apiKey", id, in: loc, name });
    } else {
      throw new Error(
        `renderSdkPackage: unsupported security scheme '${id}' (type=${type}, scheme=${scheme}). ` +
          `Supported: http+bearer, http+basic, apiKey. ` +
          `See KNOWN_GAPS.md for the wedge scope.`,
      );
    }
  }
  return out;
}

// ---- Operation extraction ----

const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

/**
 * Extracts all operations from the OAS doc with their operationId, tags,
 * HTTP method, and path template. Operations without operationId are skipped.
 */
export function extractOperations(oasJson: string): readonly OperationInfo[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const paths = doc.paths ?? {};
  const out: OperationInfo[] = [];
  for (const pathKey of Object.keys(paths).sort()) {
    const item = paths[pathKey]!;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      if (!op.operationId) continue;
      out.push({
        operationId: op.operationId,
        tags: Array.isArray(op.tags) ? [...op.tags] : [],
        method: method.toUpperCase(),
        path: pathKey,
      });
    }
  }
  return out;
}
