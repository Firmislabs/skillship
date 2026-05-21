import { describe, expect, test } from "vitest";
import { buildNamespaceTree, type OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
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

  test("rejects namespace that is not a valid JS identifier", () => {
    const ops: OperationInfo[] = [
      { operationId: "doSomething", tags: ["my-bad-tag"] },
    ];
    expect(() => buildNamespaceTree(ops, EMPTY_OVERLAY)).toThrow(
      /namespace "my-bad-tag".*not a valid JS identifier/,
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
