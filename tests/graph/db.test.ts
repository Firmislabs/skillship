import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";

describe("openGraph", () => {
  let ctx: TmpCtx;
  let handle: GraphDb | null = null;

  beforeEach(() => {
    ctx = makeTmpCtx();
  });

  afterEach(() => {
    if (handle) {
      handle.close();
      handle = null;
    }
    ctx.cleanup();
  });

  it("creates the sqlite file at the requested path", () => {
    handle = openGraph(ctx.dbPath);
    expect(existsSync(ctx.dbPath)).toBe(true);
  });

  it("applies the DDL (core tables exist)", () => {
    handle = openGraph(ctx.dbPath);
    const rows = handle.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[];
    const tableNames = rows.map((r) => r.name);
    for (const expected of [
      "claims",
      "edges",
      "nodes",
      "overrides",
      "release_sources",
      "releases",
      "snapshots",
      "sources",
    ]) {
      expect(tableNames).toContain(expected);
    }
  });

  it("is idempotent when called twice on the same file", () => {
    const first = openGraph(ctx.dbPath);
    first.close();
    handle = openGraph(ctx.dbPath);
    const rows = handle.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='nodes'",
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("enables foreign key enforcement", () => {
    handle = openGraph(ctx.dbPath);
    const fk = handle.db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
  });
});
