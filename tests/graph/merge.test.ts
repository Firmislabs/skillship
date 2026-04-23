import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import {
  chooseWinningClaim,
  DEFAULT_PRECEDENCE,
} from "../../src/graph/merge.js";
import {
  insertClaim,
  insertNode,
  insertOverride,
  listClaimsForField,
  upsertSource,
  type ClaimRow,
} from "../../src/graph/repo.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";

function iso(): string {
  return new Date().toISOString();
}

function seedBasics(handle: GraphDb): void {
  upsertSource(handle.db, {
    id: "src-openapi",
    surface: "rest",
    url: "https://api.example.com/openapi.json",
    content_type: "application/json",
    fetched_at: iso(),
    bytes: 100,
    cache_path: ".skillship/sources/src-openapi.json",
  });
  upsertSource(handle.db, {
    id: "src-docs",
    surface: "docs",
    url: "https://docs.example.com/page",
    content_type: "text/markdown",
    fetched_at: iso(),
    bytes: 100,
    cache_path: ".skillship/sources/src-docs.md",
  });
  upsertSource(handle.db, {
    id: "src-llms",
    surface: "llms_txt",
    url: "https://example.com/llms.txt",
    content_type: "text/plain",
    fetched_at: iso(),
    bytes: 80,
    cache_path: ".skillship/sources/src-llms.txt",
  });
  insertNode(handle.db, {
    id: "n1",
    kind: "operation",
    parent_id: null,
    created_at: iso(),
    updated_at: iso(),
  });
}

function claim(overrides: Partial<ClaimRow> & Pick<ClaimRow, "id">): ClaimRow {
  return {
    node_id: "n1",
    field: "summary",
    value_json: JSON.stringify("x"),
    source_id: "src-openapi",
    extractor: "openapi@3",
    extracted_at: iso(),
    span_start: null,
    span_end: null,
    span_path: null,
    confidence: "attested",
    chosen: 0,
    rejection_rationale: null,
    ...overrides,
  };
}

describe("chooseWinningClaim", () => {
  let ctx: TmpCtx;
  let handle: GraphDb;

  beforeEach(() => {
    ctx = makeTmpCtx();
    handle = openGraph(ctx.dbPath);
    seedBasics(handle);
  });

  afterEach(() => {
    handle.close();
    ctx.cleanup();
  });

  it("picks the claim with higher-precedence extractor", () => {
    insertClaim(
      handle.db,
      claim({
        id: "c-openapi",
        value_json: JSON.stringify("OpenAPI wins"),
        source_id: "src-openapi",
        extractor: "openapi@3",
      }),
    );
    insertClaim(
      handle.db,
      claim({
        id: "c-docs",
        value_json: JSON.stringify("Docs value"),
        source_id: "src-docs",
        extractor: "docs@1",
      }),
    );
    const result = chooseWinningClaim(handle.db, "n1", "summary");
    expect(result.kind).toBe("winner");
    if (result.kind !== "winner") throw new Error("unreachable");
    expect(result.chosen.id).toBe("c-openapi");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.id).toBe("c-docs");
    const rows = listClaimsForField(handle.db, "n1", "summary");
    const winner = rows.find((r) => r.id === "c-openapi");
    const loser = rows.find((r) => r.id === "c-docs");
    expect(winner?.chosen).toBe(1);
    expect(loser?.chosen).toBe(0);
    expect(loser?.rejection_rationale).toBeTruthy();
  });

  it("active override wins over any claim (including attested)", () => {
    insertClaim(
      handle.db,
      claim({
        id: "c-attested",
        value_json: JSON.stringify("machine value"),
        confidence: "attested",
        extractor: "openapi@3",
      }),
    );
    insertOverride(handle.db, {
      id: "o-1",
      node_id: "n1",
      field: "summary",
      value_json: JSON.stringify("human-authored value"),
      rationale: "machine summary was misleading",
      authored_by: "riteshkew1001@gmail.com",
      authored_at: iso(),
      supersedes: null,
      active: 1,
    });
    const result = chooseWinningClaim(handle.db, "n1", "summary");
    expect(result.kind).toBe("override");
    if (result.kind !== "override") throw new Error("unreachable");
    expect(JSON.parse(result.override.value_json)).toBe("human-authored value");
    const rows = listClaimsForField(handle.db, "n1", "summary");
    const attested = rows.find((r) => r.id === "c-attested");
    expect(attested?.chosen).toBe(0);
    expect(attested?.rejection_rationale).toContain("override");
  });

  it("tie at same precedence marks every candidate as conflicted", () => {
    upsertSource(handle.db, {
      id: "src-openapi-b",
      surface: "rest",
      url: "https://api.example.com/v2/openapi.json",
      content_type: "application/json",
      fetched_at: iso(),
      bytes: 120,
      cache_path: ".skillship/sources/src-openapi-b.json",
    });
    insertClaim(
      handle.db,
      claim({
        id: "c-a",
        value_json: JSON.stringify("A"),
        source_id: "src-openapi",
        extractor: "openapi@3",
      }),
    );
    insertClaim(
      handle.db,
      claim({
        id: "c-b",
        value_json: JSON.stringify("B"),
        source_id: "src-openapi-b",
        extractor: "openapi@3",
      }),
    );
    const result = chooseWinningClaim(handle.db, "n1", "summary");
    expect(result.kind).toBe("conflicted");
    if (result.kind !== "conflicted") throw new Error("unreachable");
    expect(result.candidates).toHaveLength(2);
    const rows = listClaimsForField(handle.db, "n1", "summary");
    for (const r of rows) {
      expect(r.chosen).toBe(0);
      expect(r.confidence).toBe("conflicted");
      expect(r.rejection_rationale).toBeTruthy();
    }
  });

  it("returns kind=none when no claims exist", () => {
    const result = chooseWinningClaim(handle.db, "n1", "summary");
    expect(result.kind).toBe("none");
  });

  it("DEFAULT_PRECEDENCE ranks openapi above llms-txt above docs", () => {
    expect(DEFAULT_PRECEDENCE.extractor["openapi@3"]).toBeGreaterThan(
      DEFAULT_PRECEDENCE.extractor["llms-txt@1"] ?? 0,
    );
    expect(DEFAULT_PRECEDENCE.extractor["llms-txt@1"]).toBeGreaterThan(
      DEFAULT_PRECEDENCE.extractor["docs@1"] ?? 0,
    );
  });
});
