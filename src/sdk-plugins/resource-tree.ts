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
// Fallback when no overlay rule matches: use the operation's tags[0],
// which R-OAS derives from the REST path's first non-template segment
// or the GraphQL root type (per renderers/oas.ts buildTags).
//
// If tags[0] is also absent, the op lands under "default".
import type { CodegenOverlay } from "../overlays/codegen.js";

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

/**
 * Resolves the emitted method name for an operation: uses overlay rename if set,
 * otherwise falls back to operationId. Used consistently in tree building AND
 * lookup so renamed ops correctly route to their real method+path.
 */
function resolveMethodName(op: OperationInfo, overlay: CodegenOverlay): string {
  return overlay.resources[op.operationId]?.rename ?? op.operationId;
}

export function buildNamespaceTree(
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): Record<string, string[]> {
  const tree: Record<string, string[]> = {};
  const seen: Record<string, Set<string>> = {};
  for (const op of ops) {
    const rule = overlay.resources[op.operationId];
    const namespace = rule?.namespace ?? op.tags[0] ?? "default";
    const methodName = resolveMethodName(op, overlay);
    assertValidName("namespace", namespace, op.operationId);
    assertValidName("method", methodName, op.operationId);
    if (RESERVED_NAMESPACES.has(namespace)) {
      throw new Error(
        `resource-tree: namespace "${namespace}" (for operation "${op.operationId}") collides with a Client member; rename the namespace in the overlay`,
      );
    }
    const seenInNs = seen[namespace] ??= new Set();
    if (seenInNs.has(methodName)) {
      throw new Error(
        `resource-tree: duplicate method "${namespace}.${methodName}" (operation "${op.operationId}"); two ops cannot map to the same namespace.method pair`,
      );
    }
    seenInNs.add(methodName);
    (tree[namespace] ??= []).push(methodName);
  }
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(tree).sort()) sorted[k] = tree[k]!;
  return sorted;
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
 * @param ops     All operations (used to look up method + path per operationId).
 * @param overlay The codegen overlay — used to resolve renamed method names
 *                so the lookup correctly maps renamed leaves to their ops.
 */
export function generateResourceTreeModule(
  tree: Record<string, string[]>,
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): string {
  // Build a lookup from resolved method name → OperationInfo so we wire
  // the correct HTTP method and path into each wrapper.
  const opsByMethodName = buildOpsByMethodName(ops, overlay);

  const lines: string[] = [];
  lines.push("// Auto-generated by @skillship/sdk-plugin-resource-tree. Do not edit by hand.");
  lines.push('import { Client } from "./runtime.js";');
  lines.push("");
  lines.push("export interface ResourceTree {");
  for (const ns of Object.keys(tree)) {
    const methods = tree[ns]!;
    const members = methods.map(m => `${m}: (opts?: RequestOpts) => Promise<Response>`);
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
      const info = opsByMethodName[methodName];
      if (!info) {
        throw new Error(
          `resource-tree: no operation metadata for method "${methodName}"; tree leaf has no matching OperationInfo`,
        );
      }
      const httpMethod = info.method;
      const httpPath = info.path;
      lines.push(
        `      ${methodName}: (opts?: RequestOpts) => client.request({ method: "${httpMethod}", path: "${httpPath}", pathParams: opts?.pathParams, query: opts?.query, headers: opts?.headers, body: opts?.body }),`,
      );
    }
    lines.push(`    },`);
  }
  lines.push("  });");
  lines.push("}");
  return lines.join("\n") + "\n";
}

/**
 * Builds a mapping from each resolved method name to its OperationInfo.
 * Uses resolveMethodName so that renamed ops are found by their new name.
 */
function buildOpsByMethodName(
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): Record<string, OperationInfo> {
  const result: Record<string, OperationInfo> = {};
  for (const op of ops) {
    result[resolveMethodName(op, overlay)] = op;
  }
  return result;
}
