import { describe, expect, test } from "vitest";
import {
  buildNamespaceTree,
  generateResourceTreeModule,
  type OperationInfo,
} from "../../src/sdk-plugins/resource-tree.js";
import type { CodegenOverlay } from "../../src/overlays/codegen.js";

const EMPTY_OVERLAY: CodegenOverlay = { resources: {}, streaming: [] };

describe("resource-tree plugin", () => {
  test("places ops under tags[0] when no overlay rule matches", () => {
    const ops: OperationInfo[] = [
      { operationId: "listProjects", tags: ["projects"] },
      { operationId: "createProject", tags: ["projects"] },
      { operationId: "listUsers", tags: ["users"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      projects: ["listProjects", "createProject"],
      users: ["listUsers"],
    });
  });

  test("overlay rename rewrites the leaf method name", () => {
    const ops: OperationInfo[] = [
      { operationId: "listProjects", tags: ["projects"] },
    ];
    const overlay: CodegenOverlay = {
      resources: { listProjects: { namespace: "projects", rename: "list" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    expect(tree).toEqual({ projects: ["list"] });
  });

  test("overlay namespace overrides tags[0]", () => {
    const ops: OperationInfo[] = [
      { operationId: "issueCreate", tags: ["mutation"] },
    ];
    const overlay: CodegenOverlay = {
      resources: { issueCreate: { namespace: "issues" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    expect(tree).toEqual({ issues: ["issueCreate"] });
  });

  test("falls back to 'default' when no tags[0] and no overlay rule", () => {
    const ops: OperationInfo[] = [
      { operationId: "ping", tags: [] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ default: ["ping"] });
  });

  test("deterministic ordering: namespaces sorted, methods preserved in input order", () => {
    const ops: OperationInfo[] = [
      { operationId: "z_first", tags: ["zulu"] },
      { operationId: "a_second", tags: ["alpha"] },
      { operationId: "a_first", tags: ["alpha"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(Object.keys(tree)).toEqual(["alpha", "zulu"]);
    expect(tree.alpha).toEqual(["a_second", "a_first"]);
  });

  test("sanitizes a derived hyphenated namespace to a valid identifier", () => {
    const ops: OperationInfo[] = [
      { operationId: "op_a", tags: ["api-keys"] },
      { operationId: "op_b", tags: ["contact-properties"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      apiKeys: ["op_a"],
      contactProperties: ["op_b"],
    });
  });

  test("preserves an already-valid derived namespace verbatim (incl. underscores)", () => {
    const ops: OperationInfo[] = [
      { operationId: "op_x", tags: ["my_resource"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ my_resource: ["op_x"] });
  });

  test("groups multiple ops sharing a sanitized namespace", () => {
    const ops: OperationInfo[] = [
      { operationId: "op_create", tags: ["api-keys"] },
      { operationId: "op_list", tags: ["api-keys"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ apiKeys: ["op_create", "op_list"] });
  });

  test("rejects an EXPLICIT overlay namespace that is not a valid identifier", () => {
    const ops: OperationInfo[] = [
      { operationId: "doSomething", tags: ["alpha"] },
    ];
    const overlay: CodegenOverlay = {
      resources: { doSomething: { namespace: "my-bad-ns" } },
      streaming: [],
    };
    expect(() => buildNamespaceTree(ops, overlay)).toThrow(
      /namespace "my-bad-ns".*not a valid JS identifier/,
    );
  });

  test("rejects rename that is not a valid JS identifier", () => {
    const ops: OperationInfo[] = [
      { operationId: "doSomething", tags: ["alpha"] },
    ];
    const overlay: CodegenOverlay = {
      resources: { doSomething: { namespace: "alpha", rename: "1bad" } },
      streaming: [],
    };
    expect(() => buildNamespaceTree(ops, overlay)).toThrow(
      /method "1bad".*not a valid JS identifier/,
    );
  });

  test("rejects namespace that collides with a Client member", () => {
    const ops: OperationInfo[] = [
      { operationId: "ping", tags: ["request"] },
    ];
    expect(() => buildNamespaceTree(ops, EMPTY_OVERLAY)).toThrow(
      /namespace "request".*collides with a Client member/,
    );
  });

  test("rejects duplicate (namespace, method) pairs", () => {
    const ops: OperationInfo[] = [
      { operationId: "listProjectsV1", tags: ["projects"] },
      { operationId: "listProjectsV2", tags: ["projects"] },
    ];
    const overlay: CodegenOverlay = {
      resources: {
        listProjectsV1: { namespace: "projects", rename: "list" },
        listProjectsV2: { namespace: "projects", rename: "list" },
      },
      streaming: [],
    };
    expect(() => buildNamespaceTree(ops, overlay)).toThrow(
      /duplicate method "projects\.list"/,
    );
  });
});

describe("generateResourceTreeModule — wedge routing", () => {
  test("emitted module routes calls through client.request (not flat SDK transport)", () => {
    const ops: OperationInfo[] = [
      {
        operationId: "listProjects",
        tags: ["projects"],
        method: "GET",
        path: "/projects",
      },
      {
        operationId: "createProject",
        tags: ["projects"],
        method: "POST",
        path: "/projects",
      },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    // Wedge transport must be invoked — the generated code must call client.request
    expect(source).toContain("client.request(");
    // Must NOT directly delegate to flat functions (would bypass wedge)
    expect(source).not.toContain("flat.listProjects");
    expect(source).not.toContain("flat.createProject");
    // Must have correct HTTP method and path wired in
    expect(source).toContain('"GET"');
    expect(source).toContain('"/projects"');
    expect(source).toContain('"POST"');
  });

  test("emitted module includes ResourceTree interface and attachResources export", () => {
    const ops: OperationInfo[] = [
      {
        operationId: "listUsers",
        tags: ["users"],
        method: "GET",
        path: "/users",
      },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    expect(source).toContain("ResourceTree");
    expect(source).toContain("attachResources");
    expect(source).toContain("users");
    expect(source).toContain("listUsers");
  });

  // I1: renamed ops must use the real method+path, not GET /
  test("renamed op emits real HTTP method+path, not GET / (I1)", () => {
    const ops: OperationInfo[] = [
      {
        operationId: "listProjects",
        tags: ["projects"],
        method: "GET",
        path: "/projects",
      },
    ];
    const overlay: CodegenOverlay = {
      resources: { listProjects: { namespace: "projects", rename: "list" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    const source = generateResourceTreeModule(tree, ops, overlay);
    expect(source).toContain('path: "/projects"');
    expect(source).toContain('method: "GET"');
    // Must not fall back to the sentinel values
    expect(source).not.toContain('path: "/"');
    // The method name in the interface must be the renamed one
    expect(source).toContain("list:");
  });

  // I2: RequestOpts must include pathParams
  test("emitted RequestOpts interface includes pathParams (I2)", () => {
    const ops: OperationInfo[] = [
      {
        operationId: "getProject",
        tags: ["projects"],
        method: "GET",
        path: "/projects/{id}",
      },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    const source = generateResourceTreeModule(tree, ops, EMPTY_OVERLAY);
    expect(source).toContain("pathParams");
    expect(source).toContain("opts?.pathParams");
  });
});
