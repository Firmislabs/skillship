// src/sdk-plugins/resource-tree-pages.ts
// Emission helpers for resource-tree.ts: all functions that build line arrays
// for the generated resources.ts module. Kept in a sibling file so both src
// files stay ≤300 lines (house-rule).
//
// Circular-import note: this file imports TYPES from resource-tree.ts (erased
// at compile time) but no runtime values. resource-tree.ts imports functions
// from this file. The dependency is one-directional at runtime.
import type { Assignment, OperationInfo } from "./resource-tree.js";
import type { PaginationPlan } from "../renderers/pagination-detect.js";

// ─── opByLeaf map ─────────────────────────────────────────────────────────────

/** Builds the `"${namespace}.${methodName}" → OperationInfo` lookup map. */
export function buildOpByLeaf(
  assignments: readonly Assignment[],
): Record<string, OperationInfo> {
  const opByLeaf: Record<string, OperationInfo> = {};
  for (const a of assignments) {
    opByLeaf[`${a.namespace}.${a.methodName}`] = a.op;
  }
  return opByLeaf;
}

// ─── ResourceTree interface emission ─────────────────────────────────────────

/** Emits the ResourceTree interface block (header, per-namespace member rows, footer). */
export function emitResourceTreeInterface(
  tree: Record<string, string[]>,
  opByLeaf: Record<string, OperationInfo>,
  plans: ReadonlyMap<string, PaginationPlan>,
): string[] {
  const lines: string[] = ["", "export interface ResourceTree {"];
  for (const ns of Object.keys(tree)) {
    const members: string[] = [];
    for (const m of tree[ns]!) {
      members.push(`${m}: (opts?: RequestOpts) => Promise<Response>`);
      const info = opByLeaf[`${ns}.${m}`];
      if (info && plans.has(info.operationId)) {
        members.push(`${m}Pages: (opts?: RequestOpts) => AsyncGenerator<unknown>`);
      }
    }
    lines.push(`  readonly ${ns}: { ${members.join("; ")} };`);
  }
  lines.push("}");
  return lines;
}

// ─── RequestOpts interface emission ──────────────────────────────────────────

/** Emits the RequestOpts interface block. */
export function emitRequestOptsInterface(): string[] {
  return [
    "",
    "interface RequestOpts {",
    "  query?: Record<string, string | number | boolean | undefined>;",
    "  headers?: Record<string, string>;",
    "  body?: unknown;",
    "  pathParams?: Record<string, string | number>;",
    "}",
  ];
}

// ─── attachResources emission ─────────────────────────────────────────────────

/** Emits the attachResources function and all namespace object literals. */
export function emitAttachResources(
  tree: Record<string, string[]>,
  opByLeaf: Record<string, OperationInfo>,
  plans: ReadonlyMap<string, PaginationPlan>,
): string[] {
  const lines: string[] = [
    "",
    "export function attachResources(client: Client): Client & ResourceTree {",
    "  return Object.assign(client, {",
  ];
  for (const ns of Object.keys(tree)) {
    lines.push(`    ${ns}: {`);
    for (const methodName of tree[ns]!) {
      const info = opByLeaf[`${ns}.${methodName}`];
      if (!info) {
        throw new Error(
          `resource-tree: no operation metadata for method "${ns}.${methodName}"; tree leaf has no matching OperationInfo`,
        );
      }
      const { method: httpMethod, path: httpPath } = info;
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
  return lines;
}

// ─── *Pages method emission ────────────────────────────────────────────────────

/**
 * Emits the `<methodName>Pages` async-generator method lines for a planned op.
 * The fetch closure reuses the plain method's request construction (same method
 * + path) with per-page param overrides merged into the query. The plan is baked
 * as a literal so the emitted code has no runtime dependency on the emitter.
 * When the plan has a pageSizeParam, the caller-supplied page size is extracted
 * from opts.query and passed as the explicit third argument to paginate() so the
 * fewer-than-requested stop can fire; otherwise undefined is passed.
 */
export function emitPagesMethod(
  methodName: string,
  httpMethod: string,
  httpPath: string,
  plan: PaginationPlan,
  opId: string,
): string[] {
  const planLiteral = buildPlanLiteral(plan, opId);
  const requestedPageSizeExpr =
    plan.pageSizeParam !== null
      ? `typeof opts?.query?.["${plan.pageSizeParam}"] === "number" ? opts.query["${plan.pageSizeParam}"] as number : undefined`
      : `undefined`;
  return [
    `      ${methodName}Pages: (opts?: RequestOpts): AsyncGenerator<unknown> => paginate<unknown>(`,
    `        (pageArgs) => client.request({ method: "${httpMethod}", path: "${httpPath}", pathParams: opts?.pathParams, query: { ...opts?.query, ...pageArgs as Record<string, string | number | boolean | undefined> }, headers: opts?.headers, body: opts?.body }).then((r) => r.json() as Promise<unknown>),`,
    `        ${planLiteral},`,
    `        ${requestedPageSizeExpr},`,
    `      ),`,
  ];
}

/** Serializes a PaginationPlan + opId as a TS object literal (no `any`). */
export function buildPlanLiteral(plan: PaginationPlan, opId: string): string {
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
