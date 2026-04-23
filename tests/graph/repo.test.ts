import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openGraph, type GraphDb } from "../../src/graph/db.js";
import {
  insertClaim,
  insertEdge,
  insertNode,
  listClaimsForField,
  listEdgesFrom,
  upsertSource,
  setClaimChosen,
  getNode,
} from "../../src/graph/repo.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";

function iso(): string {
  return new Date().toISOString();
}

function seedSource(handle: GraphDb, id: string, surface = "rest"): void {
  upsertSource(handle.db, {
    id,
    surface: surface as "rest",
    url: `https://example.com/${id}.json`,
    content_type: "application/json",
    fetched_at: iso(),
    bytes: 123,
    cache_path: `.skillship/sources/${id}.json`,
  });
}

describe("graph repo", () => {
  let ctx: TmpCtx;
  let handle: GraphDb;

  beforeEach(() => {
    ctx = makeTmpCtx();
    handle = openGraph(ctx.dbPath);
  });

  afterEach(() => {
    handle.close();
    ctx.cleanup();
  });

  it("round-trips a Product node with >=3 chosen claims", () => {
    seedSource(handle, "srcA");
    insertNode(handle.db, {
      id: "prod-supabase",
      kind: "product",
      parent_id: null,
      created_at: iso(),
      updated_at: iso(),
    });
    const baseClaim = {
      node_id: "prod-supabase",
      source_id: "srcA",
      extractor: "openapi@3",
      extracted_at: iso(),
      span_start: null,
      span_end: null,
      span_path: null,
      confidence: "attested" as const,
      chosen: 1 as const,
      rejection_rationale: null,
    };
    insertClaim(handle.db, {
      ...baseClaim,
      id: "c-name",
      field: "name",
      value_json: JSON.stringify("Supabase"),
    });
    insertClaim(handle.db, {
      ...baseClaim,
      id: "c-domain",
      field: "domain",
      value_json: JSON.stringify("supabase.com"),
    });
    insertClaim(handle.db, {
      ...baseClaim,
      id: "c-tagline",
      field: "tagline",
      value_json: JSON.stringify("Postgres, but opinionated"),
    });

    const row = getNode(handle.db, "prod-supabase");
    expect(row?.kind).toBe("product");
    const nameClaims = listClaimsForField(handle.db, "prod-supabase", "name");
    expect(nameClaims).toHaveLength(1);
    expect(nameClaims[0]?.chosen).toBe(1);
    expect(JSON.parse(nameClaims[0]!.value_json)).toBe("Supabase");
  });

  it("round-trips a Surface node with 3 chosen claims", () => {
    seedSource(handle, "srcB");
    insertNode(handle.db, {
      id: "prod-1",
      kind: "product",
      parent_id: null,
      created_at: iso(),
      updated_at: iso(),
    });
    insertNode(handle.db, {
      id: "surf-1",
      kind: "surface",
      parent_id: "prod-1",
      created_at: iso(),
      updated_at: iso(),
    });
    const base = {
      node_id: "surf-1",
      source_id: "srcB",
      extractor: "openapi@3",
      extracted_at: iso(),
      span_start: null,
      span_end: null,
      span_path: null,
      confidence: "attested" as const,
      chosen: 1 as const,
      rejection_rationale: null,
    };
    insertClaim(handle.db, {
      ...base,
      id: "sc-v",
      field: "version",
      value_json: JSON.stringify("v1"),
    });
    insertClaim(handle.db, {
      ...base,
      id: "sc-b",
      field: "base_url",
      value_json: JSON.stringify("https://api.supabase.com"),
    });
    insertClaim(handle.db, {
      ...base,
      id: "sc-s",
      field: "spec_url",
      value_json: JSON.stringify("https://api.supabase.com/api/v1/openapi.json"),
    });

    for (const field of ["version", "base_url", "spec_url"]) {
      const rows = listClaimsForField(handle.db, "surf-1", field);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.chosen).toBe(1);
    }
  });

  it("round-trips an Operation node with 3 chosen claims", () => {
    seedSource(handle, "srcC");
    insertNode(handle.db, {
      id: "op-1",
      kind: "operation",
      parent_id: "surf-1",
      created_at: iso(),
      updated_at: iso(),
    });
    const base = {
      node_id: "op-1",
      source_id: "srcC",
      extractor: "openapi@3",
      extracted_at: iso(),
      span_start: null,
      span_end: null,
      span_path: null,
      confidence: "attested" as const,
      chosen: 1 as const,
      rejection_rationale: null,
    };
    insertClaim(handle.db, {
      ...base,
      id: "oc-m",
      field: "method",
      value_json: JSON.stringify("POST"),
    });
    insertClaim(handle.db, {
      ...base,
      id: "oc-p",
      field: "path_or_name",
      value_json: JSON.stringify("/projects"),
    });
    insertClaim(handle.db, {
      ...base,
      id: "oc-s",
      field: "summary",
      value_json: JSON.stringify("Create a project"),
    });
    const m = listClaimsForField(handle.db, "op-1", "method");
    expect(m).toHaveLength(1);
    expect(JSON.parse(m[0]!.value_json)).toBe("POST");
    expect(m[0]?.chosen).toBe(1);
  });

  it("setClaimChosen flips a prior winner to loser with rejection_rationale", () => {
    seedSource(handle, "srcD");
    insertNode(handle.db, {
      id: "n1",
      kind: "product",
      parent_id: null,
      created_at: iso(),
      updated_at: iso(),
    });
    insertClaim(handle.db, {
      id: "claim-old",
      node_id: "n1",
      field: "name",
      value_json: JSON.stringify("OldName"),
      source_id: "srcD",
      extractor: "docs@1",
      extracted_at: iso(),
      span_start: null,
      span_end: null,
      span_path: null,
      confidence: "attested",
      chosen: 1,
      rejection_rationale: null,
    });
    setClaimChosen(handle.db, "claim-old", 0, "superseded by override");
    const rows = listClaimsForField(handle.db, "n1", "name");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chosen).toBe(0);
    expect(rows[0]?.rejection_rationale).toBe("superseded by override");
  });

  it("insertEdge is idempotent on (from, to, kind)", () => {
    insertNode(handle.db, {
      id: "p",
      kind: "product",
      parent_id: null,
      created_at: iso(),
      updated_at: iso(),
    });
    insertNode(handle.db, {
      id: "s",
      kind: "surface",
      parent_id: "p",
      created_at: iso(),
      updated_at: iso(),
    });
    insertEdge(handle.db, {
      id: "e1",
      kind: "exposes",
      from_node_id: "p",
      to_node_id: "s",
      source_id: null,
      rationale: null,
      created_at: iso(),
    });
    insertEdge(handle.db, {
      id: "e2",
      kind: "exposes",
      from_node_id: "p",
      to_node_id: "s",
      source_id: null,
      rationale: null,
      created_at: iso(),
    });
    const edges = listEdgesFrom(handle.db, "p");
    expect(edges).toHaveLength(1);
    expect(edges[0]?.id).toBe("e1");
  });

  it("upsertSource returns the existing row on duplicate id", () => {
    const a = upsertSource(handle.db, {
      id: "dup-sha",
      surface: "rest",
      url: "https://example.com/a.json",
      content_type: "application/json",
      fetched_at: iso(),
      bytes: 42,
      cache_path: ".skillship/sources/dup-sha.json",
    });
    const b = upsertSource(handle.db, {
      id: "dup-sha",
      surface: "rest",
      url: "https://example.com/a.json",
      content_type: "application/json",
      fetched_at: iso(),
      bytes: 42,
      cache_path: ".skillship/sources/dup-sha.json",
    });
    expect(a.id).toBe("dup-sha");
    expect(b.id).toBe("dup-sha");
    const count = handle.db
      .prepare("SELECT COUNT(*) AS c FROM sources WHERE id = ?")
      .get("dup-sha") as { c: number };
    expect(count.c).toBe(1);
  });
});
