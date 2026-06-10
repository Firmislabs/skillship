// src/sdk-plugins/resource-tree.ts
// Reshapes the generated client into nested namespaces that route through
// the wedge Client.request() method. This ensures auth injection, timeout,
// throwForResponse, and onRequest/onResponse hooks run for every call.
//
// Design: Path A (direct wrapper emission)
// Each namespace method is emitted as an arrow function that calls
// client.request({ method, path, query, headers, body }). This is the
// canonical wedge transport — identical to what the user would write by hand.
// The flat SDK functions from @hey-api/sdk are NOT used at runtime; they are
// only consulted for codegen metadata (operationId → tags mapping). This means
// Hey API's internal transport is bypassed entirely.
//
// Data source contract (locked in spec §5.3):
//   The plugin reads resources rename/namespace rules from the CodegenOverlay
//   object passed through the plugin factory closure. The x-skillship-codegen
//   vendor extension on the OAS doc is INFORMATIONAL and NOT re-parsed here.
//   Single source of truth: the CodegenOverlay Zod-validated object.
//
// Method-name resolution (highest precedence first):
//   1. overlay rename — author intent, validated strictly.
//   2. a readable name derived from (HTTP method, path): GET collection→list,
//      GET item→get, POST→create, PUT/PATCH→update, DELETE→delete, and a
//      trailing literal action segment (e.g. /emails/{id}/cancel→cancel).
//   Operation ids are content-addressed hashes and are NEVER surfaced as
//   method names — derived collisions within a namespace are disambiguated
//   with a short, deterministic op-hash suffix rather than thrown.
//
// Namespace fallback when no overlay rule matches: the operation's tags[0],
// which R-OAS derives from the REST path's first non-template segment or the
// GraphQL root type (per renderers/oas.ts buildTags). If tags[0] is absent,
// the op lands under "default".
import type { CodegenOverlay } from "../overlays/codegen.js";
import type { PaginationPlan } from "../renderers/pagination-detect.js";

export interface OperationInfo {
  readonly operationId: string;
  readonly tags: readonly string[];
  /** HTTP method (uppercase). Required for wedge wrapper emission. */
  readonly method: string;
  /** Path template as it appears in the OAS doc (e.g. "/projects/{id}"). */
  readonly path: string;
}

// JS identifier shape: must start with letter/$/_ then any combination of those plus digits.
// Intentionally narrower than the ECMAScript spec's Unicode allowance — keeps emitted code
// readable and avoids escaping headaches in interface declarations.
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Reserved names: instance properties/methods on the emitted Client class
// (see src/sdk-plugins/runtime.ts). Namespacing onto any of these would silently
// clobber the Client surface via Object.assign.
const RESERVED_NAMESPACES: ReadonlySet<string> = new Set([
  "baseUrl",
  "auth",
  "defaultHeaders",
  "fetchImpl",
  "timeout",
  "onRequest",
  "onResponse",
  "request",
]);

// HTTP method → default verb for resource-shaped paths (collections and items).
const METHOD_VERB: Readonly<Record<string, string>> = {
  GET: "list",
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete",
  HEAD: "head",
  OPTIONS: "options",
  TRACE: "trace",
};

/** A fully resolved placement for one operation: where it lives and what it's called. */
export interface Assignment {
  readonly op: OperationInfo;
  readonly namespace: string;
  readonly methodName: string;
}

export function buildNamespaceTree(
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): Record<string, string[]> {
  const tree: Record<string, string[]> = {};
  for (const a of resolveAssignments(ops, overlay)) {
    (tree[a.namespace] ??= []).push(a.methodName);
  }
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(tree).sort()) sorted[k] = tree[k]!;
  return sorted;
}

/**
 * Single deterministic pass that places every operation: resolves its
 * namespace, then its method name (overlay rename → derived → disambiguated),
 * tracking seen names per namespace so collisions are handled consistently.
 * Both tree-building and resource emission consume this so the emitted leaf
 * names and the request-lookup keys can never drift apart.
 */
export function resolveAssignments(
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): Assignment[] {
  const seen: Record<string, Set<string>> = {};
  const out: Assignment[] = [];
  for (const op of ops) {
    const rule = overlay.resources[op.operationId];
    const namespace = resolveNamespace(op, rule);
    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new Error(
        `resource-tree: namespace "${namespace}" (for operation "${op.operationId}") collides with a Client member; rename the namespace in the overlay`,
      );
    }
    const nsSeen = (seen[namespace] ??= new Set());
    const methodName = resolveMethodName(op, rule, namespace, nsSeen);
    nsSeen.add(methodName);
    out.push({ op, namespace, methodName });
  }
  return out;
}

function resolveNamespace(
  op: OperationInfo,
  rule: CodegenOverlay["resources"][string] | undefined,
): string {
  // Explicit overlay namespaces are author intent and stay strict (invalid
  // ones are an actionable config error). Derived namespaces come from the
  // path's first segment and are auto-sanitized to a valid identifier so real
  // specs (e.g. "api-keys") emit without requiring an overlay entry.
  if (rule?.namespace !== undefined) {
    assertValidName("namespace", rule.namespace, op.operationId);
    return rule.namespace;
  }
  return deriveNamespace(op.tags[0] ?? "default");
}

function resolveMethodName(
  op: OperationInfo,
  rule: CodegenOverlay["resources"][string] | undefined,
  namespace: string,
  nsSeen: ReadonlySet<string>,
): string {
  // Overlay rename wins outright; a collision here is an author error, so throw.
  if (rule?.rename !== undefined) {
    assertValidName("method", rule.rename, op.operationId);
    if (nsSeen.has(rule.rename)) throw duplicateError(namespace, rule.rename, op.operationId);
    return rule.rename;
  }
  const base = deriveMethodName(op.method, op.path);
  if (!nsSeen.has(base)) return base;
  // Two operations derived the same readable name (e.g. two GET-by-id paths in
  // one namespace). First try a readable qualifier from a distinguishing path
  // segment (e.g. "getAttachments"); only if that is unavailable or itself taken
  // do we fall back to the deterministic op-hash tail. Overlay rename remains the
  // way to get a fully clean name.
  const qualified = qualifyWithSegment(base, op.path);
  if (qualified !== undefined && !nsSeen.has(qualified)) return qualified;
  const disambiguated = `${base}_${opHashTail(op.operationId)}`;
  if (nsSeen.has(disambiguated)) throw duplicateError(namespace, disambiguated, op.operationId);
  return disambiguated;
}

/**
 * Qualifies a colliding base method name with a distinguishing literal path
 * segment: the deepest non-template, non-leading segment whose camelCased form
 * differs from the base. Returns `${base}${PascalCaseSegment}` (e.g. base "get"
 * on "/emails/{id}/attachments/{attachment_id}" -> "getAttachments"), or
 * undefined when no such segment exists.
 */
function qualifyWithSegment(base: string, path: string): string | undefined {
  const p = path ?? "";
  const hashIdx = p.lastIndexOf("#");
  const usable = hashIdx >= 0 ? p.slice(0, hashIdx) : p;
  const segs = usable.split("/").filter((s) => s.length > 0);
  for (let i = segs.length - 1; i >= 1; i--) {
    const seg = segs[i]!;
    if (/^\{.+\}$/.test(seg)) continue;
    const camel = camelCaseParts(seg);
    if (camel.length === 0 || camel === base) continue;
    return `${base}${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  }
  return undefined;
}

function duplicateError(namespace: string, methodName: string, opId: string): Error {
  return new Error(
    `resource-tree: duplicate method "${namespace}.${methodName}" (operation "${opId}"); two ops cannot map to the same namespace.method pair`,
  );
}

/**
 * Maps a derived namespace (the path's first segment) to a valid JS identifier.
 * Already-valid names (incl. underscores) pass through verbatim so emitted code
 * is stable; otherwise non-alphanumeric runs are dropped and the remaining
 * segments are camelCased (e.g. "api-keys" -> "apiKeys"). Empty result falls
 * back to "default".
 */
function deriveNamespace(raw: string): string {
  if (IDENTIFIER_RE.test(raw)) return raw;
  const camel = camelCaseParts(raw);
  return camel.length > 0 ? camel : "default";
}

/**
 * Derives a readable method name from the operation's HTTP method and path.
 * A "#fragment" in the path (GraphQL ops are projected as "/graphql#fieldName")
 * is the operation's own name and wins outright. Otherwise a trailing literal
 * segment that is not the bare resource (e.g. the "cancel" in
 * "/emails/{id}/cancel", or "batch" in "/emails/batch") is treated as a named
 * action; failing that the name comes from the HTTP verb, with GET on a single
 * item ("/emails/{id}") mapping to "get" rather than "list".
 */
function deriveMethodName(method: string, path: string): string {
  const p = path ?? "";
  const hashIdx = p.lastIndexOf("#");
  if (hashIdx >= 0) {
    const frag = camelCaseParts(p.slice(hashIdx + 1));
    if (frag.length > 0) return frag;
  }
  const m = (method ?? "GET").toUpperCase();
  const segs = p.split("/").filter((s) => s.length > 0);
  const last = segs[segs.length - 1];
  const lastIsParam = last !== undefined && /^\{.+\}$/.test(last);
  let base: string;
  if (last !== undefined && !lastIsParam && segs.length >= 2) {
    base = last;
  } else if (lastIsParam && m === "GET") {
    base = "get";
  } else {
    base = METHOD_VERB[m] ?? m.toLowerCase();
  }
  const id = camelCaseParts(base);
  return id.length > 0 ? id : "call";
}

/** A short, deterministic suffix from an operationId for collision disambiguation. */
function opHashTail(operationId: string): string {
  const alnum = operationId.replace(/[^A-Za-z0-9]/g, "");
  return alnum.length > 0 ? alnum.slice(-8) : "x";
}

/** Splits on non-alphanumerics and camelCases; prefixes "_" if it starts with a digit. */
function camelCaseParts(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return "";
  const camel =
    parts[0]! +
    parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
  return /^[0-9]/.test(camel) ? `_${camel}` : camel;
}

function assertValidName(kind: "namespace" | "method", name: string, opId: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `resource-tree: ${kind} "${name}" (for operation "${opId}") is not a valid JS identifier; must match /^[A-Za-z_$][A-Za-z0-9_$]*$/`,
    );
  }
}

/**
 * Generates the resources.ts content that routes each operation through
 * the wedge Client.request() method. Each namespace method is an arrow
 * function wrapper that builds a request object and delegates to
 * client.request(), ensuring auth injection, timeout enforcement,
 * throwForResponse, and lifecycle hooks all execute on every call.
 *
 * The flat functions from @hey-api/sdk are NOT called at runtime;
 * OperationInfo carries the metadata (method, path) needed to construct
 * the request object directly.
 *
 * @param tree    The namespace tree from buildNamespaceTree (ns → method names).
 * @param ops     All operations (re-resolved here to map each leaf to its op).
 * @param overlay The codegen overlay — used to resolve namespaces + method
 *                names identically to buildNamespaceTree.
 * @param plans   Optional pagination plans keyed by operationId. When a plan
 *                exists for an op, a sibling `<method>Pages` async-generator
 *                method is emitted alongside the plain method. Defaults to an
 *                empty map so the existing call site in sdk.ts compiles and
 *                renders byte-identically until Task 8 wires it.
 */
export function generateResourceTreeModule(
  tree: Record<string, string[]>,
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
  plans: ReadonlyMap<string, PaginationPlan> = new Map(),
): string {
  // Re-run the same deterministic assignment to map each (namespace, method)
  // leaf back to its OperationInfo, so we wire the correct HTTP method + path.
  // Also build a reverse map: operationId → methodName for Pages emission.
  const opByLeaf: Record<string, OperationInfo> = {};
  const methodByOpId: Record<string, string> = {};
  for (const a of resolveAssignments(ops, overlay)) {
    opByLeaf[`${a.namespace}.${a.methodName}`] = a.op;
    methodByOpId[a.op.operationId] = a.methodName;
  }

  const hasPlan = plans.size > 0;

  const lines: string[] = [];
  lines.push("// Auto-generated by @skillship/sdk-plugin-resource-tree. Do not edit by hand.");
  lines.push('import { Client } from "./runtime.js";');
  if (hasPlan) {
    lines.push('import { paginate } from "./pagination.js";');
  }
  lines.push("");
  lines.push("export interface ResourceTree {");
  for (const ns of Object.keys(tree)) {
    const methods = tree[ns]!;
    const members: string[] = [];
    for (const m of methods) {
      members.push(`${m}: (opts?: RequestOpts) => Promise<Response>`);
      const info = opByLeaf[`${ns}.${m}`];
      if (info && plans.has(info.operationId)) {
        members.push(`${m}Pages: (opts?: RequestOpts) => AsyncGenerator<unknown>`);
      }
    }
    lines.push(`  readonly ${ns}: { ${members.join("; ")} };`);
  }
  lines.push("}");
  lines.push("");
  lines.push("interface RequestOpts {");
  lines.push("  query?: Record<string, string | number | boolean | undefined>;");
  lines.push("  headers?: Record<string, string>;");
  lines.push("  body?: unknown;");
  lines.push("  pathParams?: Record<string, string | number>;");
  lines.push("}");
  lines.push("");
  lines.push("export function attachResources(client: Client): Client & ResourceTree {");
  lines.push("  return Object.assign(client, {");
  for (const ns of Object.keys(tree)) {
    const methods = tree[ns]!;
    lines.push(`    ${ns}: {`);
    for (const methodName of methods) {
      const info = opByLeaf[`${ns}.${methodName}`];
      if (!info) {
        throw new Error(
          `resource-tree: no operation metadata for method "${ns}.${methodName}"; tree leaf has no matching OperationInfo`,
        );
      }
      const httpMethod = info.method;
      const httpPath = info.path;
      lines.push(
        `      ${methodName}: (opts?: RequestOpts) => client.request({ method: "${httpMethod}", path: "${httpPath}", pathParams: opts?.pathParams, query: opts?.query, headers: opts?.headers, body: opts?.body }),`,
      );
      const plan = plans.get(info.operationId);
      if (plan) {
        lines.push(...emitPagesMethod(methodName, httpMethod, httpPath, plan, info.operationId));
      }
    }
    lines.push(`    },`);
  }
  lines.push("  });");
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * Emits the `<methodName>Pages` async-generator method lines for a planned op.
 * The fetch closure reuses the plain method's request construction (same method
 * + path) with per-page param overrides merged into the query. The plan is baked
 * as a literal so the emitted code has no runtime dependency on the emitter.
 */
function emitPagesMethod(
  methodName: string,
  httpMethod: string,
  httpPath: string,
  plan: PaginationPlan,
  opId: string,
): string[] {
  const planLiteral = buildPlanLiteral(plan, opId);
  return [
    `      ${methodName}Pages: (opts?: RequestOpts): AsyncGenerator<unknown> => paginate<unknown>(`,
    `        (pageArgs) => client.request({ method: "${httpMethod}", path: "${httpPath}", pathParams: opts?.pathParams, query: { ...opts?.query, ...pageArgs as Record<string, string | number | boolean | undefined> }, headers: opts?.headers, body: opts?.body }).then((r) => r.json() as Promise<unknown>),`,
    `        ${planLiteral},`,
    `      ),`,
  ];
}

/** Serializes a PaginationPlan + opId as a TS object literal (no `any`). */
function buildPlanLiteral(plan: PaginationPlan, opId: string): string {
  const pageSizeParam =
    plan.pageSizeParam === null ? "null" : `"${plan.pageSizeParam}"`;
  const nextField =
    plan.nextField === null ? "null" : `"${plan.nextField}"`;
  return (
    `{ style: "${plan.style}", requestParam: "${plan.requestParam}", ` +
    `pageSizeParam: ${pageSizeParam}, itemsField: "${plan.itemsField}", ` +
    `nextField: ${nextField}, opId: "${opId}" }`
  );
}
