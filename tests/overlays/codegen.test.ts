// tests/overlays/codegen.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadCodegenOverlay, type CodegenOverlay, CodegenOverlaySchema, applyOverlayToDoc } from "../../src/overlays/codegen.js";

describe("loadCodegenOverlay", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sk-ovl-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("returns defaults when no overlay file exists", () => {
    const ovl = loadCodegenOverlay(dir);
    expect(ovl.resources).toEqual({});
    expect(ovl.pagination).toBeUndefined();
    expect(ovl.streaming).toEqual([]);
    expect(ovl.retries).toBeUndefined();
    expect(ovl.auth).toBeUndefined();
    expect(ovl.webhooks).toBeUndefined();
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
        "  fields: { requestParam: cursor, itemsField: data, nextField: next_cursor }",
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
    expect(ovl.retries?.backoff).toBe("exponential-jitter");
    expect(ovl.retries?.honorRetryAfter).toBe(true);
    expect(ovl.retries?.retryableStatus).toEqual([408, 409, 429, 500, 502, 503, 504]);
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

test("applyOverlayToDoc renames operationId and overrides tags", () => {
  const doc: any = { paths: { "/p": { get: { operationId: "op_a", tags: ["old"] } } } };
  applyOverlayToDoc(doc, CodegenOverlaySchema.parse({ resources: { op_a: { namespace: "users", rename: "list" } } }));
  expect(doc.paths["/p"].get.operationId).toBe("list");
  expect(doc.paths["/p"].get.tags).toEqual(["users"]);
});

test("applyOverlayToDoc stamps document-level x-skillship-codegen", () => {
  const doc: any = { paths: {} };
  applyOverlayToDoc(doc, CodegenOverlaySchema.parse({ pagination: { style: "cursor" }, streaming: ["op_b"] }));
  expect(doc["x-skillship-codegen"].pagination.style).toBe("cursor");
  expect(doc["x-skillship-codegen"].streaming).toEqual(["op_b"]);
});

describe("Auth schema — tokenUrl", () => {
  test("parses and round-trips tokenUrl for oauth2-client-credentials", () => {
    const result = CodegenOverlaySchema.parse({
      auth: {
        mode: "oauth2-client-credentials",
        tokenUrl: "https://x/oauth/token",
      },
    });
    expect(result.auth?.tokenUrl).toBe("https://x/oauth/token");
  });

  test("bearer auth without tokenUrl still parses", () => {
    const result = CodegenOverlaySchema.parse({
      auth: { mode: "bearer" },
    });
    expect(result.auth?.mode).toBe("bearer");
    expect(result.auth?.tokenUrl).toBeUndefined();
  });

  test("rejects an invalid (non-URL) tokenUrl", () => {
    expect(() =>
      CodegenOverlaySchema.parse({
        auth: { mode: "oauth2-client-credentials", tokenUrl: "not-a-url" },
      }),
    ).toThrow();
  });
});

describe("Pagination.fields — fixed keys", () => {
  test("parses valid fixed field keys", () => {
    const result = CodegenOverlaySchema.parse({
      pagination: {
        style: "cursor",
        fields: { requestParam: "cursor", itemsField: "data", nextField: "next_cursor" },
      },
    });
    expect(result.pagination?.fields.requestParam).toBe("cursor");
    expect(result.pagination?.fields.itemsField).toBe("data");
    expect(result.pagination?.fields.nextField).toBe("next_cursor");
  });

  test("parses all four fixed field keys", () => {
    const result = CodegenOverlaySchema.parse({
      pagination: {
        style: "offset",
        fields: {
          requestParam: "page",
          pageSizeParam: "per_page",
          itemsField: "items",
          nextField: "next",
        },
      },
    });
    expect(result.pagination?.fields.pageSizeParam).toBe("per_page");
  });

  test("rejects unknown field keys (strict)", () => {
    expect(() =>
      CodegenOverlaySchema.parse({
        pagination: {
          style: "cursor",
          fields: { bogus: "x" },
        },
      }),
    ).toThrow();
  });

  test("pagination.fields defaults to empty object when omitted", () => {
    const result = CodegenOverlaySchema.parse({
      pagination: { style: "page" },
    });
    expect(result.pagination?.fields).toEqual({});
  });
});
