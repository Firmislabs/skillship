import { describe, expect, test } from "vitest";
import {
  buildNamespaceTree,
  generateResourceTreeModule,
  type OperationInfo,
} from "../../src/sdk-plugins/resource-tree.js";
import type { CodegenOverlay } from "../../src/overlays/codegen.js";

const EMPTY_OVERLAY: CodegenOverlay = { resources: {}, streaming: [] };

function op(
  operationId: string,
  tags: string[],
  method: string,
  path: string,
): OperationInfo {
  return { operationId, tags, method, path };
}

describe("resource-tree plugin", () => {
  test("derives readable method names from (method, path) under tags[0]", () => {
    const ops: OperationInfo[] = [
      op("op_a", ["projects"], "GET", "/projects"),
      op("op_b", ["projects"], "POST", "/projects"),
      op("op_c", ["users"], "GET", "/users"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      projects: ["list", "create"],
      users: ["list"],
    });
  });

  test("overlay rename rewrites the leaf method name (takes precedence over derivation)", () => {
    const ops: OperationInfo[] = [op("op_a", ["projects"], "GET", "/projects")];
    const overlay: CodegenOverlay = {
      resources: { op_a: { namespace: "projects", rename: "fetchAll" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    expect(tree).toEqual({ projects: ["fetchAll"] });
  });

  test("overlay namespace overrides tags[0]", () => {
    const ops: OperationInfo[] = [op("op_a", ["mutation"], "POST", "/issues")];
    const overlay: CodegenOverlay = {
      resources: { op_a: { namespace: "issues" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    expect(tree).toEqual({ issues: ["create"] });
  });

  test("falls back to 'default' namespace when no tags[0] and no overlay rule", () => {
    const ops: OperationInfo[] = [op("ping", [], "GET", "/ping")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ default: ["list"] });
  });

  test("deterministic ordering: namespaces sorted, methods preserved in input order", () => {
    const ops: OperationInfo[] = [
      op("z_first", ["zulu"], "GET", "/zulu"),
      op("a_second", ["alpha"], "POST", "/alpha"),
      op("a_first", ["alpha"], "GET", "/alpha"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(Object.keys(tree)).toEqual(["alpha", "zulu"]);
    expect(tree.alpha).toEqual(["create", "list"]);
  });

  test("sanitizes a derived hyphenated namespace to a valid identifier", () => {
    const ops: OperationInfo[] = [
      op("op_a", ["api-keys"], "GET", "/api-keys"),
      op("op_b", ["contact-properties"], "GET", "/contact-properties"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      apiKeys: ["list"],
      contactProperties: ["list"],
    });
  });

  test("preserves an already-valid derived namespace verbatim (incl. underscores)", () => {
    const ops: OperationInfo[] = [op("op_x", ["my_resource"], "GET", "/my_resource")];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ my_resource: ["list"] });
  });

  test("groups multiple ops sharing a sanitized namespace", () => {
    const ops: OperationInfo[] = [
      op("op_create", ["api-keys"], "POST", "/api-keys"),
      op("op_list", ["api-keys"], "GET", "/api-keys"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ apiKeys: ["create", "list"] });
  });

  test("rejects an EXPLICIT overlay namespace that is not a valid identifier", () => {
    const ops: OperationInfo[] = [op("op_a", ["alpha"], "GET", "/alpha")];
    const overlay: CodegenOverlay = {
      resources: { op_a: { namespace: "my-bad-ns" } },
      streaming: [],
    };
    expect(() => buildNamespaceTree(ops, overlay)).toThrow(
      /namespace "my-bad-ns".*not a valid JS identifier/,
    );
  });

  test("rejects rename that is not a valid JS identifier", () => {
    const ops: OperationInfo[] = [op("op_a", ["alpha"], "GET", "/alpha")];
    const overlay: CodegenOverlay = {
      resources: { op_a: { namespace: "alpha", rename: "1bad" } },
      streaming: [],
    };
    expect(() => buildNamespaceTree(ops, overlay)).toThrow(
      /method "1bad".*not a valid JS identifier/,
    );
  });

  test("rejects namespace that collides with a Client member", () => {
    const ops: OperationInfo[] = [op("ping", ["request"], "GET", "/request")];
    expect(() => buildNamespaceTree(ops, EMPTY_OVERLAY)).toThrow(
      /namespace "request".*collides with a Client member/,
    );
  });

  test("rejects duplicate (namespace, method) pairs from overlay renames", () => {
    const ops: OperationInfo[] = [
      op("listProjectsV1", ["projects"], "GET", "/projects"),
      op("listProjectsV2", ["projects"], "GET", "/v2/projects"),
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

describe("method-name derivation (Gap 5)", () => {
  test("GET collection -> list, GET single-item -> get", () => {
    const ops: OperationInfo[] = [
      op("op_list", ["emails"], "GET", "/emails"),
      op("op_get", ["emails"], "GET", "/emails/{email_id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ emails: ["list", "get"] });
  });

  test("POST -> create, PATCH/PUT -> update, DELETE -> delete", () => {
    const ops: OperationInfo[] = [
      op("op_c", ["domains"], "POST", "/domains"),
      op("op_u", ["domains"], "PATCH", "/domains/{domain_id}"),
      op("op_u2", ["topics"], "PUT", "/topics/{id}"),
      op("op_d", ["domains"], "DELETE", "/domains/{domain_id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      domains: ["create", "update", "delete"],
      topics: ["update"],
    });
  });

  test("trailing literal action segment becomes the method name", () => {
    const ops: OperationInfo[] = [
      op("op_cancel", ["emails"], "POST", "/emails/{email_id}/cancel"),
      op("op_batch", ["emails"], "POST", "/emails/batch"),
      op("op_verify", ["domains"], "POST", "/domains/{domain_id}/verify"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      emails: ["cancel", "batch"],
      domains: ["verify"],
    });
  });

  test("camelCases a hyphenated action segment", () => {
    const ops: OperationInfo[] = [
      op("op_x", ["broadcasts"], "POST", "/broadcasts/{id}/send-now"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ broadcasts: ["sendNow"] });
  });

  test("GraphQL #fragment in the path becomes the method name", () => {
    const ops: OperationInfo[] = [
      op("op_m", ["mutation"], "POST", "/graphql#createProject"),
      op("op_q", ["query"], "POST", "/graphql#projects"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      mutation: ["createProject"],
      query: ["projects"],
    });
  });

  test("derived collision within a namespace is disambiguated deterministically (not thrown)", () => {
    const ops: OperationInfo[] = [
      op("op_aaaaaaaa", ["emails"], "GET", "/emails/{email_id}"),
      op("op_bbbbbbbb", ["emails"], "GET", "/emails/{email_id}/attachments/{attachment_id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree.emails).toHaveLength(2);
    expect(tree.emails![0]).toBe("get");
    // Second GET-single-item collides on "get" → qualified with the deepest
    // distinguishing literal segment ("attachments") rather than an op hash.
    expect(tree.emails![1]).toBe("getAttachments");
    expect(tree.emails![1]).not.toBe("get");
    // Deterministic across calls.
    const again = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(again.emails).toEqual(tree.emails);
  });

  test("Gap 7: a colliding GET on a deeper path gets a qualified name, not an op-hash suffix", () => {
    const ops: OperationInfo[] = [
      op("op_one", ["emails"], "GET", "/emails/{email_id}"),
      op("op_two", ["emails"], "GET", "/emails/{email_id}/attachments/{attachment_id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree.emails![1]).toBe("getAttachments");
    expect(tree.emails![1]).not.toMatch(/^get_[0-9a-f]/);
    const again = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(again.emails).toEqual(tree.emails);
  });

  test("Gap 7: falls back to op-hash suffix when no distinguishing segment exists", () => {
    const ops: OperationInfo[] = [
      op("op_aaaaaaaa", ["emails"], "GET", "/emails/{email_id}"),
      op("op_bbbbbbbb", ["emails"], "GET", "/emails/{other_id}"),
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree.emails![0]).toBe("get");
    expect(tree.emails![1]).toMatch(/^get_/);
    expect(tree.emails![1]).not.toBe("get");
  });
});

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
