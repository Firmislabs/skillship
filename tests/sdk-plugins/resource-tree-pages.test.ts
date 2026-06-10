import { describe, expect, test } from "vitest";
import {
  buildNamespaceTree,
  generateResourceTreeModule,
  type OperationInfo,
} from "../../src/sdk-plugins/resource-tree.js";
import type { CodegenOverlay } from "../../src/overlays/codegen.js";
import type { PaginationPlan } from "../../src/renderers/pagination-detect.js";

const EMPTY_OVERLAY: CodegenOverlay = { resources: {}, streaming: [] };

function op(
  operationId: string,
  tags: string[],
  method: string,
  path: string,
): OperationInfo {
  return { operationId, tags, method, path };
}

describe("generateResourceTreeModule — wedge routing", () => {
  test("emitted module routes calls through client.request (not flat SDK transport)", () => {
    const ops: OperationInfo[] = [
      op("op_list", ["projects"], "GET", "/projects"),
      op("op_create", ["projects"], "POST", "/projects"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    expect(source).toContain("client.request(");
    expect(source).not.toContain("flat.op_list");
    expect(source).toContain('"GET"');
    expect(source).toContain('"/projects"');
    expect(source).toContain('"POST"');
    // Readable derived names appear, not the opId hashes.
    expect(source).toContain("list:");
    expect(source).toContain("create:");
    expect(source).not.toContain("op_list");
  });

  test("emitted module includes ResourceTree interface and attachResources export", () => {
    const ops: OperationInfo[] = [op("op_list", ["users"], "GET", "/users")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    expect(source).toContain("ResourceTree");
    expect(source).toContain("attachResources");
    expect(source).toContain("users");
    expect(source).toContain("list:");
  });

  // I1: renamed ops must use the real method+path, not GET /
  test("renamed op emits real HTTP method+path, not GET / (I1)", () => {
    const ops: OperationInfo[] = [op("op_list", ["projects"], "GET", "/projects")];
    const overlay: CodegenOverlay = {
      resources: { op_list: { namespace: "projects", rename: "list" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    const source = generateResourceTreeModule(tree, ops, overlay);
    expect(source).toContain('path: "/projects"');
    expect(source).toContain('method: "GET"');
    expect(source).not.toContain('path: "/"');
    expect(source).toContain("list:");
  });

  // I2: RequestOpts must include pathParams
  test("emitted RequestOpts interface includes pathParams (I2)", () => {
    const ops: OperationInfo[] = [
      op("op_get", ["projects"], "GET", "/projects/{id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    expect(source).toContain("pathParams");
    expect(source).toContain("opts?.pathParams");
  });

  test("disambiguated collision leaf still resolves to its real op metadata", () => {
    const ops: OperationInfo[] = [
      op("op_aaaaaaaa", ["emails"], "GET", "/emails/{email_id}"),
      op("op_bbbbbbbb", ["emails"], "GET", "/emails/{email_id}/attachments/{attachment_id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    // Must not throw "no operation metadata for method"; both paths must appear.
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    expect(source).toContain('path: "/emails/{email_id}"');
    expect(source).toContain(
      'path: "/emails/{email_id}/attachments/{attachment_id}"',
    );
  });
});

// ─── Pagination glue: *Pages methods ──────────────────────────────────────────

describe("generateResourceTreeModule — *Pages glue (T7)", () => {
  const CURSOR_PLAN: PaginationPlan = {
    style: "cursor",
    requestParam: "cursor",
    pageSizeParam: "limit",
    itemsField: "data",
    nextField: "next_cursor",
  };

  const OFFSET_PLAN: PaginationPlan = {
    style: "offset",
    requestParam: "offset",
    pageSizeParam: "limit",
    itemsField: "items",
    nextField: null,
  };

  const PAGE_PLAN: PaginationPlan = {
    style: "page",
    requestParam: "page",
    pageSizeParam: "per_page",
    itemsField: "data",
    nextField: null,
  };

  // Snapshot the no-plan emission first to assert byte-identity
  const NO_PLAN_OPS: OperationInfo[] = [
    op("op_list", ["projects"], "GET", "/projects"),
    op("op_create", ["projects"], "POST", "/projects"),
  ];

  test("no-plan case: emission is byte-identical to no-plans-param call", () => {
    const tree = buildNamespaceTree(NO_PLAN_OPS, EMPTY_OVERLAY);
    // Call with empty plans map (default) vs explicit empty map — must be identical
    const withDefault = generateResourceTreeModule(tree, NO_PLAN_OPS, EMPTY_OVERLAY);
    const withEmptyMap = generateResourceTreeModule(tree, NO_PLAN_OPS, EMPTY_OVERLAY, new Map());
    expect(withDefault).toBe(withEmptyMap);
  });

  test("no-plan case: does NOT emit ./pagination.js import or *Pages methods", () => {
    const tree = buildNamespaceTree(NO_PLAN_OPS, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, NO_PLAN_OPS, EMPTY_OVERLAY);
    expect(source).not.toContain("./pagination");
    expect(source).not.toContain("Pages");
    expect(source).not.toContain("paginate");
  });

  test("cursor plan: emits ./pagination.js import when at least one plan exists", () => {
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toContain('./pagination.js"');
  });

  test("cursor plan: emits listPages method alongside list", () => {
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toContain("listPages");
    // Plain method must still be emitted unchanged
    expect(source).toContain("list:");
    expect(source).toContain('method: "GET"');
    expect(source).toContain('path: "/emails"');
  });

  test("cursor plan: listPages delegates to paginate with plan baked in", () => {
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    // paginate is called with explicit generic (paginate<unknown>)
    expect(source).toContain("paginate<unknown>(");
    // Plan fields baked as literals
    expect(source).toContain('"cursor"');
    expect(source).toContain('"next_cursor"');
    expect(source).toContain('"data"');
    // opId baked in
    expect(source).toContain('"op_list"');
  });

  test("cursor plan: listPages returns AsyncGenerator<unknown>", () => {
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toContain("AsyncGenerator<unknown>");
  });

  test("offset plan: emits listPages with offset style baked in", () => {
    const ops: OperationInfo[] = [op("op_list", ["orders"], "GET", "/orders")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", OFFSET_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toContain("listPages");
    expect(source).toContain('"offset"');
    expect(source).toContain('"items"');
  });

  test("page plan: emits listPages with page style baked in", () => {
    const ops: OperationInfo[] = [op("op_list", ["users"], "GET", "/users")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", PAGE_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toContain("listPages");
    expect(source).toContain('"page"');
    expect(source).toContain('"per_page"');
  });

  test("only planned ops get *Pages; unplanned ops in the same namespace do not", () => {
    const ops: OperationInfo[] = [
      op("op_list", ["projects"], "GET", "/projects"),
      op("op_create", ["projects"], "POST", "/projects"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    // Only list is planned
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toContain("listPages");
    // create should NOT have createPages
    expect(source).not.toContain("createPages");
  });

  test("plan in ResourceTree interface lists *Pages method alongside plain method", () => {
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    // Both list and listPages must appear in the ResourceTree interface
    expect(source).toContain("list:");
    expect(source).toContain("listPages:");
  });

  test("*Pages fetch closure reuses the plain method's request construction (same method+path)", () => {
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    // The closure passed to paginate must use the same method+path as the plain method
    // Both 'method: "GET"' and 'path: "/emails"' must appear (used by plain + Pages)
    const getCount = (source.match(/"GET"/g) ?? []).length;
    const pathCount = (source.match(/\/emails/g) ?? []).length;
    expect(getCount).toBeGreaterThanOrEqual(1);
    expect(pathCount).toBeGreaterThanOrEqual(2); // once in plain, once in Pages closure
  });

  test("renamed op with plan: Pages method uses the renamed method name with Pages suffix", () => {
    const ops: OperationInfo[] = [op("op_list", ["projects"], "GET", "/projects")];
    const overlay: CodegenOverlay = {
      resources: { op_list: { namespace: "projects", rename: "fetchAll" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, overlay, plans);
    expect(source).toContain("fetchAllPages");
    expect(source).toContain("fetchAll:");
  });

  test("plans parameter on generateResourceTreeModule is optional (no-arg compiles)", () => {
    // The signature must allow calling without plans (defaults to empty map)
    const ops: OperationInfo[] = [op("op_list", ["projects"], "GET", "/projects")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    // Must not throw when called without plans argument
    expect(() => generateResourceTreeModule(tree, ops, EMPTY_OVERLAY)).not.toThrow();
  });

  test("cursor plan with pageSizeParam: emits requestedPageSize extraction from opts.query", () => {
    // The *Pages method must extract the caller-supplied page size from opts.query
    // and pass it as the third argument to paginate() so the fewer-than-requested
    // stop guard can fire. pageSizeParam is "limit" in CURSOR_PLAN.
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", CURSOR_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    // Must extract the pageSizeParam value from opts.query by name
    expect(source).toContain('"limit"');
    // Must guard the extraction with a typeof number check
    expect(source).toMatch(/typeof\s+opts\?\.query\?\.(?:\["limit"\]|\["limit"\])\s*===\s*"number"/);
  });

  test("offset plan with pageSizeParam: emits requestedPageSize extraction from opts.query", () => {
    const ops: OperationInfo[] = [op("op_list", ["orders"], "GET", "/orders")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", OFFSET_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    expect(source).toMatch(/typeof\s+opts\?\.query\?\.(?:\["limit"\])\s*===\s*"number"/);
  });

  test("plan with null pageSizeParam: emits undefined (no extraction)", () => {
    // pageSizeParam null: pass literal `undefined` as third paginate() arg.
    const NULL_SIZE_PLAN: PaginationPlan = {
      style: "cursor",
      requestParam: "cursor",
      pageSizeParam: null,
      itemsField: "data",
      nextField: "next_cursor",
    };
    const ops: OperationInfo[] = [op("op_list", ["emails"], "GET", "/emails")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const plans: ReadonlyMap<string, PaginationPlan> = new Map([["op_list", NULL_SIZE_PLAN]]);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY, plans);
    // Must pass undefined, NOT attempt to read a pageSizeParam key
    expect(source).toContain("undefined");
    expect(source).not.toMatch(/opts\?\.query\?\.null/);
  });
});
