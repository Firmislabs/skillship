import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import {
  extensionFor,
  storeSource,
} from "../../src/sources/store.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";

describe("storeSource", () => {
  let ctx: TmpCtx;
  let handle: GraphDb;
  let sourcesDir: string;

  beforeEach(() => {
    ctx = makeTmpCtx();
    handle = openGraph(ctx.dbPath);
    sourcesDir = join(ctx.dir, "sources");
  });

  afterEach(() => {
    handle.close();
    ctx.cleanup();
  });

  it("writes bytes to <sha256>.<ext> and inserts one sources row", () => {
    const bytes = Buffer.from('{"hello":"world"}', "utf8");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");
    const node = storeSource(handle.db, sourcesDir, {
      url: "https://example.com/data.json",
      bytes,
      content_type: "application/json",
      surface: "rest",
    });
    expect(node.id).toBe(expectedSha);
    expect(node.kind).toBe("source");
    expect(node.surface).toBe("rest");
    expect(node.bytes).toBe(bytes.length);
    const expectedPath = join(sourcesDir, `${expectedSha}.json`);
    expect(node.cache_path).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath)).toEqual(bytes);
    const count = handle.db
      .prepare("SELECT COUNT(*) AS c FROM sources")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("is content-addressable: same bytes twice = one row, same node", () => {
    const bytes = Buffer.from("same-bytes", "utf8");
    const first = storeSource(handle.db, sourcesDir, {
      url: "https://a.example.com/x",
      bytes,
      content_type: "text/plain",
      surface: "docs",
    });
    const second = storeSource(handle.db, sourcesDir, {
      url: "https://b.example.com/y",
      bytes,
      content_type: "text/plain",
      surface: "docs",
    });
    expect(second.id).toBe(first.id);
    const count = handle.db
      .prepare("SELECT COUNT(*) AS c FROM sources")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("different bytes produce different sha256 ids", () => {
    const a = storeSource(handle.db, sourcesDir, {
      url: "https://example.com/a",
      bytes: Buffer.from("alpha"),
      content_type: "text/plain",
      surface: "docs",
    });
    const b = storeSource(handle.db, sourcesDir, {
      url: "https://example.com/b",
      bytes: Buffer.from("beta"),
      content_type: "text/plain",
      surface: "docs",
    });
    expect(a.id).not.toBe(b.id);
    const count = handle.db
      .prepare("SELECT COUNT(*) AS c FROM sources")
      .get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("extensionFor strips charset params and maps common types", () => {
    expect(extensionFor("application/json")).toBe("json");
    expect(extensionFor("application/json; charset=utf-8")).toBe("json");
    expect(extensionFor("text/plain")).toBe("txt");
    expect(extensionFor("text/markdown; charset=utf-8")).toBe("md");
    expect(extensionFor("application/yaml")).toBe("yaml");
    expect(extensionFor("text/yaml")).toBe("yaml");
    expect(extensionFor("application/xml")).toBe("xml");
    expect(extensionFor("text/html")).toBe("html");
    expect(extensionFor("application/octet-stream")).toBe("bin");
    expect(extensionFor("weird/thing")).toBe("bin");
  });
});
