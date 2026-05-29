import { describe, expect, test } from "vitest";
import {
  resolveAssignments,
  type Assignment,
  type OperationInfo,
} from "../../src/sdk-plugins/resource-tree.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

describe("resolveAssignments export", () => {
  test("returns one assignment per op with namespace + methodName", () => {
    const ops: OperationInfo[] = [
      { operationId: "op_a", tags: ["emails"], method: "GET", path: "/emails" },
      { operationId: "op_b", tags: ["emails"], method: "POST", path: "/emails" },
    ];
    const out: Assignment[] = resolveAssignments(ops, CodegenOverlaySchema.parse({}));
    expect(out).toEqual([
      { op: ops[0], namespace: "emails", methodName: "list" },
      { op: ops[1], namespace: "emails", methodName: "create" },
    ]);
  });
});
