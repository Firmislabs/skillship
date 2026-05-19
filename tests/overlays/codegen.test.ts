// tests/overlays/codegen.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadCodegenOverlay, type CodegenOverlay } from "../../src/overlays/codegen.js";

describe("loadCodegenOverlay", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sk-ovl-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns defaults when no overlay file exists", () => {
    const ovl = loadCodegenOverlay(dir);
    expect(ovl.resources).toEqual({});
    expect(ovl.pagination).toBeUndefined();
    expect(ovl.streaming).toEqual([]);
  });

  test("parses a valid overlay file", () => {
    mkdirSync(join(dir, ".skillship", "overlays"), { recursive: true });
    writeFileSync(
      join(dir, ".skillship", "overlays", "codegen.yaml"),
      [
        "resources:",
        "  op_a: { namespace: users, rename: list }",
        "pagination:",
        "  style: cursor",
        "  fields: { cursor: next_cursor, items: data, hasMore: has_more }",
        "retries: { maxRetries: 3, idempotencyHeader: Idempotency-Key }",
        "streaming: [op_b]",
      ].join("\n"),
      "utf8",
    );
    const ovl: CodegenOverlay = loadCodegenOverlay(dir);
    expect(ovl.resources.op_a).toEqual({ namespace: "users", rename: "list" });
    expect(ovl.pagination?.style).toBe("cursor");
    expect(ovl.retries?.maxRetries).toBe(3);
    expect(ovl.streaming).toEqual(["op_b"]);
  });

  test("throws a typed path error on invalid overlay", () => {
    mkdirSync(join(dir, ".skillship", "overlays"), { recursive: true });
    writeFileSync(
      join(dir, ".skillship", "overlays", "codegen.yaml"),
      "pagination: { style: not-a-style }",
      "utf8",
    );
    expect(() => loadCodegenOverlay(dir)).toThrow(/pagination\.style/);
  });
});
