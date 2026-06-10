// src/renderers/sdk-utils.ts
// OAS extraction helpers for sdk.ts.
// Kept separate to stay under the 300-line file cap while sdk.ts accumulates
// correctness fixes (EXDEV fallback, collision guards, slug validation, etc.).

import type {
  AuthSchemeDescriptor,
  RetriesConfig,
} from "../sdk-plugins/runtime.js";
import type { CodegenOverlay } from "../overlays/codegen.js";
import type { OperationInfo } from "../sdk-plugins/resource-tree.js";
import {
  detectPagination,
  type PaginationPlan,
} from "./pagination-detect.js";

// ---- Minimal OAS doc shape (read-only, subset used by extractors) ----

interface OasClientCredentialsFlow {
  readonly tokenUrl?: string;
  readonly scopes?: Record<string, string>;
}
interface OasOauth2Flows {
  readonly clientCredentials?: OasClientCredentialsFlow;
}
interface OasSecurityScheme {
  readonly type?: string;
  readonly scheme?: string;
  readonly in?: string;
  readonly name?: string;
  readonly flows?: OasOauth2Flows;
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
 * Maps a single OAS security scheme to an AuthSchemeDescriptor.
 * Never throws — unknown/unsupported types map to { kind: "external" }.
 */
function mapSecurityScheme(id: string, s: OasSecurityScheme): AuthSchemeDescriptor {
  const type = s.type ?? "";
  const scheme = s.scheme ?? "";
  if (type === "http" && scheme === "bearer") return { kind: "bearer", id };
  if (type === "http" && scheme === "basic") return { kind: "basic", id };
  if (type === "apiKey") {
    const loc: "header" | "query" = s.in === "query" ? "query" : "header";
    const name = typeof s.name === "string" ? s.name : "Authorization";
    return { kind: "apiKey", id, in: loc, name };
  }
  if (type === "oauth2") {
    const cc = s.flows?.clientCredentials;
    const tokenUrl = typeof cc?.tokenUrl === "string" ? cc.tokenUrl : null;
    const scopes = cc?.scopes != null ? Object.keys(cc.scopes) : [];
    return { kind: "oauth2ClientCredentials", id, tokenUrl, scopes };
  }
  // openIdConnect, mutualTLS, unknown — external/inert until Task 8
  return { kind: "external", id, schemeType: type };
}

/**
 * Applies overlay overrides to a descriptor.
 * If overlay.auth.mode is "oauth2-client-credentials", force the descriptor to
 * oauth2ClientCredentials (regardless of what the OAS scheme was).
 * overlay.auth.tokenUrl fills a null tokenUrl.
 */
function applyOverlayToDescriptor(
  desc: AuthSchemeDescriptor,
  overlay: CodegenOverlay | undefined,
): AuthSchemeDescriptor {
  const overlayAuth = overlay?.auth;
  if (overlayAuth?.mode !== "oauth2-client-credentials") return desc;
  const existingTokenUrl =
    desc.kind === "oauth2ClientCredentials" ? desc.tokenUrl : null;
  const tokenUrl =
    typeof overlayAuth.tokenUrl === "string"
      ? overlayAuth.tokenUrl
      : existingTokenUrl;
  const scopes =
    desc.kind === "oauth2ClientCredentials" ? desc.scopes : [];
  return { kind: "oauth2ClientCredentials", id: desc.id, tokenUrl, scopes };
}

/**
 * Parses the OAS doc and returns a descriptor per security scheme.
 * All scheme types are handled — oauth2/openIdConnect/mutualTLS/unknown map
 * to new descriptor kinds instead of throwing.
 * An optional overlay may force or augment the descriptor (e.g. tokenUrl).
 */
export function extractAuthSchemes(
  oasJson: string,
  overlay?: CodegenOverlay,
): readonly AuthSchemeDescriptor[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const schemes = doc.components?.securitySchemes ?? {};
  const out: AuthSchemeDescriptor[] = [];
  for (const id of Object.keys(schemes).sort()) {
    const raw = schemes[id]!;
    const base = mapSecurityScheme(id, raw);
    out.push(applyOverlayToDescriptor(base, overlay));
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

// ---- Wedge input computation ----

export interface WedgeInputs {
  readonly schemes: readonly AuthSchemeDescriptor[];
  readonly ops: readonly OperationInfo[];
  readonly plans: ReadonlyMap<string, PaginationPlan>;
  readonly overlay: CodegenOverlay;
  readonly envPrefix: string;
  readonly retries: RetriesConfig;
}

const DEFAULT_RETRIES: RetriesConfig = {
  maxRetries: 2,
  retryableStatus: [408, 409, 429, 500, 502, 503, 504],
  honorRetryAfter: true,
};

/**
 * Slugifies a product name to a lowercase hyphenated slug: lowercased, every
 * non-alphanumeric run collapsed to a single hyphen, leading/trailing hyphens
 * trimmed. Shared by env-prefix derivation and package-name construction.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** AGENTMIN_, MIN_EXAMPLE_, etc. — slug uppercased with hyphens → underscores. */
export function deriveEnvPrefix(productName: string): string {
  return slugify(productName).toUpperCase().replace(/-/g, "_");
}

function resolveRetries(overlay: CodegenOverlay): RetriesConfig {
  const r = overlay.retries;
  if (r === undefined) return DEFAULT_RETRIES;
  return {
    maxRetries: r.maxRetries,
    retryableStatus: r.retryableStatus,
    honorRetryAfter: r.honorRetryAfter,
  };
}

/**
 * Derives every input the wedge emitters need from the render request:
 * overlay-aware auth schemes, operations, pagination plans, the env-var prefix,
 * and the resolved retries config (overlay values fall back to contract
 * defaults). Pure — keeps renderSdkPackage small and side-effect-free here.
 */
export function computeWedgeInputs(args: {
  readonly oasJson: string;
  readonly productName: string;
  readonly overlay: CodegenOverlay;
}): WedgeInputs {
  const schemes = extractAuthSchemes(args.oasJson, args.overlay);
  const ops = extractOperations(args.oasJson);
  const plans = detectPagination(ops, args.oasJson, args.overlay);
  return {
    schemes,
    ops,
    plans,
    overlay: args.overlay,
    envPrefix: deriveEnvPrefix(args.productName),
    retries: resolveRetries(args.overlay),
  };
}
