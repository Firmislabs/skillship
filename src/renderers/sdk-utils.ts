// src/renderers/sdk-utils.ts
// OAS extraction helpers for sdk.ts.
// Kept separate to stay under the 300-line file cap while sdk.ts accumulates
// correctness fixes (EXDEV fallback, collision guards, slug validation, etc.).
// Also owns computePagesExample / computeFirstRequestExample (moved from sdk.ts).
// Auth-scheme helpers are in ./sdk-utils-auth.ts (C3 split).

import type {
  AuthSchemeDescriptor,
  RetriesConfig,
} from "../sdk-plugins/runtime.js";
import type { CodegenOverlay } from "../overlays/codegen.js";
import type { OperationInfo } from "../sdk-plugins/resource-tree.js";
import {
  resolveAssignments,
} from "../sdk-plugins/resource-tree.js";
import {
  detectPagination,
  type PaginationPlan,
} from "./pagination-detect.js";
import type { PagesExample, FirstRequestExample } from "./sdk-templates/render.js";
import {
  mapSecurityScheme,
  applyOverlayToDescriptor,
  synthesizeDescriptor,
  overlayTargetKind,
  type OasSecurityScheme,
  type OasComponents,
} from "./sdk-utils-auth.js";

// ---- Minimal OAS doc shape (read-only, subset used by extractors) ----

interface OasOperation {
  readonly operationId?: string;
  readonly tags?: readonly string[];
}
type OasPathItem = Record<string, OasOperation>;
interface OasDoc {
  readonly components?: OasComponents;
  readonly paths?: Record<string, OasPathItem>;
}

// Re-export so callers that import OasSecurityScheme from sdk-utils still work.
export type { OasSecurityScheme };

// ---- Auth scheme extraction ----

/**
 * Parses the OAS doc and returns a descriptor per security scheme.
 * All scheme types are handled — oauth2/openIdConnect/mutualTLS/unknown map
 * to new descriptor kinds instead of throwing.
 * An optional overlay may force or augment the descriptor (e.g. tokenUrl).
 * When overlay.auth.mode names a kind with no matching declared scheme,
 * a synthetic descriptor is appended (zero-scheme synthesis).
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
  if (overlay?.auth !== undefined) {
    const targetKind = overlayTargetKind(overlay.auth.mode);
    const hasTargetKind = out.some((d) => d.kind === targetKind);
    if (!hasTargetKind) {
      const synthesized = synthesizeDescriptor(overlay);
      if (synthesized !== null) out.push(synthesized);
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

// ---- Wedge input computation ----

export interface WedgeInputs {
  readonly schemes: readonly AuthSchemeDescriptor[];
  readonly ops: readonly OperationInfo[];
  readonly plans: ReadonlyMap<string, PaginationPlan>;
  readonly overlay: CodegenOverlay;
  readonly envPrefix: string;
  readonly retries: RetriesConfig;
  /**
   * Base URL from the REST surface's servers[0].url claim.
   * Stored here for later-wave consumers; intentionally unused by all emitters
   * in Wave 1 — rendered output is byte-identical to the pre-plumbing baseline.
   * null = spec declared no servers entry (or no REST surface); runtime
   * consumers fall back to `<PREFIX>_BASE_URL`. Only servers[0] is read.
   */
  readonly baseUrl: string | null;
}

export const DEFAULT_RETRIES: RetriesConfig = {
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
 * the resolved retries config (overlay values fall back to contract defaults),
 * and the base URL threaded from the REST surface claim.
 * Pure — keeps renderSdkPackage small and side-effect-free here.
 */
export function computeWedgeInputs(args: {
  readonly oasJson: string;
  readonly productName: string;
  readonly overlay: CodegenOverlay;
  readonly baseUrl: string | null;
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
    baseUrl: args.baseUrl,
  };
}

// ---- README example derivation ----

/**
 * Derives the pagesExample for the README pagination section from the first
 * plan entry (insertion order is deterministic — plans is a Map keyed by
 * operationId in the order ops appear in the OAS doc).
 * Returns null when there are no pagination plans.
 */
export function computePagesExample(wedge: WedgeInputs): PagesExample | null {
  if (wedge.plans.size === 0) return null;
  const [firstOpId] = wedge.plans.keys();
  if (firstOpId === undefined) return null;
  const plan = wedge.plans.get(firstOpId)!;
  const assignments = resolveAssignments(wedge.ops, wedge.overlay);
  const assignment = assignments.find((a) => a.op.operationId === firstOpId);
  if (assignment === undefined) return null;
  const accessor = `${assignment.namespace}.${assignment.methodName}`;
  return { accessor, pageSizeParam: plan.pageSizeParam };
}

/**
 * Derives the firstRequestExample for the README "Make a request" section.
 * Returns the accessor for the first non-paginated operation in assignment order.
 * Returns null when there are no ops at all.
 */
export function computeFirstRequestExample(wedge: WedgeInputs): FirstRequestExample | null {
  const assignments = resolveAssignments(wedge.ops, wedge.overlay);
  if (assignments.length === 0) return null;
  const first = assignments.find((a) => !wedge.plans.has(a.op.operationId));
  const target = first ?? assignments[0]!;
  return { accessor: `${target.namespace}.${target.methodName}` };
}
