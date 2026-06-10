// tests/sdk-plugins/pagination.test.ts
// TDD phase: source-pattern assertions + runtime-behavior tests.
// Runtime tests transpile the emitted module string with typescript's
// transpileModule() and evaluate it via a Function wrapper so the actual
// paginate() implementation is exercised — not just source patterns.

import { describe, expect, test } from "vitest";
import ts from "typescript";
import { generatePaginationModule } from "../../src/sdk-plugins/pagination.js";

// ─── Runtime evaluation harness (≤50 lines) ──────────────────────────────────

interface PaginatePlan {
  style: "cursor" | "offset" | "page";
  requestParam: string;
  pageSizeParam: string | null;
  itemsField: string;
  nextField: string | null;
  opId: string;
}

/** Transpile the emitted TS source to CJS and evaluate it to extract `paginate`. */
function loadEmittedPaginate(): (
  fetchPage: (pageArgs: Record<string, unknown>) => Promise<unknown>,
  plan: PaginatePlan,
  requestedPageSize?: number,
) => AsyncGenerator<unknown> {
  const src = generatePaginationModule();
  const result = ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  // Wrap in a CommonJS-style executor that captures `exports`
  const cjsWrapper = new Function("exports", "require", result.outputText);
  const exports: Record<string, unknown> = {};
  cjsWrapper(exports, () => {
    throw new Error("No imports expected in emitted pagination module");
  });
  const paginate = exports["paginate"];
  if (typeof paginate !== "function") throw new Error("paginate not found in emitted module");
  return paginate as ReturnType<typeof loadEmittedPaginate>;
}

/** Drain an AsyncGenerator into an array. */
async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

// ─── Source-pattern tests ─────────────────────────────────────────────────────

describe("generatePaginationModule — emitted engine contract", () => {
  test("emits a header comment and no-edit guard", () => {
    const src = generatePaginationModule();
    expect(src).toContain("Auto-generated");
    expect(src).toContain("Do not edit by hand");
  });

  test("exports an async generator function named paginate", () => {
    const src = generatePaginationModule();
    expect(src).toMatch(/export\s+async\s+function\s*\*\s*paginate/);
  });

  test("paginate is generic over Item", () => {
    const src = generatePaginationModule();
    expect(src).toContain("paginate<Item>");
  });

  test("paginate accepts fetchPage callback and plan literal parameters", () => {
    const src = generatePaginationModule();
    expect(src).toContain("fetchPage");
    expect(src).toContain("plan");
  });

  test("plan parameter includes all required fields (style, requestParam, pageSizeParam, itemsField, nextField, opId)", () => {
    const src = generatePaginationModule();
    expect(src).toContain("style");
    expect(src).toContain("requestParam");
    expect(src).toContain("pageSizeParam");
    expect(src).toContain("itemsField");
    expect(src).toContain("nextField");
    expect(src).toContain("opId");
  });

  test("plan style is typed as cursor | offset | page literal union", () => {
    const src = generatePaginationModule();
    expect(src).toContain('"cursor"');
    expect(src).toContain('"offset"');
    expect(src).toContain('"page"');
  });

  test("returns AsyncGenerator<Item>", () => {
    const src = generatePaginationModule();
    expect(src).toContain("AsyncGenerator<Item>");
  });

  test("emits the repeated-cursor guard (stop when next === cursor, not next === prev)", () => {
    const src = generatePaginationModule();
    // The guard compares against the cursor that PRODUCED this response,
    // not the cursor from two pages ago (prev is dead).
    expect(src).toMatch(/next\s*===\s*cursor/);
    // The old off-by-one guard must NOT appear
    expect(src).not.toMatch(/next\s*===\s*prev/);
    // The dead `prev` variable must be gone
    expect(src).not.toMatch(/\bprev\b/);
  });

  test("emits cursor stop condition: null/missing/empty next value", () => {
    const src = generatePaginationModule();
    // Cursor: stop when next is null, undefined, or empty string
    expect(src).toContain("cursor");
    // The condition should cover null/missing (falsy check or explicit checks)
    expect(src).toMatch(/next\s*==\s*null|next\s*===\s*null|!next|next\s*===\s*undefined/);
  });

  test("emits offset/page stop condition: requestedPageSize explicit third parameter", () => {
    const src = generatePaginationModule();
    // paginate gains a third parameter for the caller-supplied page size
    expect(src).toContain("requestedPageSize");
    // Must compare items.length to requestedPageSize (not pageArgs lookup which is dead)
    expect(src).toMatch(/requestedPageSize\s*!==\s*undefined/);
    expect(src).toMatch(/items\.length\s*<\s*requestedPageSize/);
    // The old dead-code pattern must be gone
    expect(src).not.toMatch(/pageArgs\[plan\.pageSizeParam\]/);
  });

  test("emits typed error naming both opId and field when itemsField is missing", () => {
    const src = generatePaginationModule();
    // Error must reference opId and itemsField in the message
    expect(src).toContain("opId");
    expect(src).toContain("itemsField");
    // Must throw an error (not silently ignore)
    expect(src).toMatch(/throw\s+new\s+(Error|TypeError)/);
  });

  test("no `any` types in emitted engine", () => {
    const src = generatePaginationModule();
    // Allow `: any` in comments but not in type positions
    // Strict check: must not contain `: any` or `<any>` or `as any`
    expect(src).not.toMatch(/:\s*any(\s|[;,\)\]]|$)/);
    expect(src).not.toContain("<any>");
    expect(src).not.toContain(" as any");
  });

  test("emitted engine is self-contained (no imports from other generated modules)", () => {
    const src = generatePaginationModule();
    // pagination.ts must be dependency-free (no imports from ./errors, ./runtime, etc.)
    expect(src).not.toContain('from "./errors');
    expect(src).not.toContain('from "./runtime');
    expect(src).not.toContain('from "./resources');
  });

  test("emitted output is deterministic across multiple calls", () => {
    const a = generatePaginationModule();
    const b = generatePaginationModule();
    expect(a).toBe(b);
  });
});

// ─── Runtime-behavior tests (execute the transpiled emitted code) ─────────────

describe("paginate() runtime — cursor style", () => {
  const CURSOR_PLAN: PaginatePlan = {
    style: "cursor",
    requestParam: "cursor",
    pageSizeParam: "limit",
    itemsField: "data",
    nextField: "next_cursor",
    opId: "op_test",
  };

  test("happy path: 3 pages ending next:null yields all items, exactly 3 fetch calls", async () => {
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { data: [1, 2], next_cursor: "page2" },
      { data: [3, 4], next_cursor: "page3" },
      { data: [5], next_cursor: null },
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, CURSOR_PLAN));
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
  });

  test("Bug 1 — repeated-cursor guard fires after exactly 2 fetches (not 3)", async () => {
    // Server repeats cursor "A" on the second page: a naive off-by-one guard
    // compares next against `prev` (two pages ago) instead of `cursor`
    // (the cursor that produced this response), so it fires one iteration late.
    // Correct guard: fetchPage is called EXACTLY 2 times.
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { data: [1], next_cursor: "A" },
      { data: [2], next_cursor: "A" }, // server repeats cursor "A" → must stop here
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      if (idx >= pages.length) throw new Error("fetchPage called too many times");
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, CURSOR_PLAN));
    expect(items).toEqual([1, 2]);
    // MUST be exactly 2, not 3 (the off-by-one bug would cause 3)
    expect(calls).toHaveLength(2);
  });
});

describe("paginate() runtime — offset/page style", () => {
  const OFFSET_PLAN: PaginatePlan = {
    style: "offset",
    requestParam: "offset",
    pageSizeParam: "limit",
    itemsField: "items",
    nextField: null,
    opId: "op_offset",
  };

  test("Bug 2a — offset style, requestedPageSize=2: stops after partial page (2 fetch calls, no third)", async () => {
    // pageArgs only carries the offset counter, never the page size,
    // so the old `pageArgs[plan.pageSizeParam]` lookup is always undefined.
    // The fix passes requestedPageSize as an explicit third argument.
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { items: ["a", "b"] }, // full page (2 items) → continue
      { items: ["c"] },      // partial page (1 < 2) → stop
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      if (idx >= pages.length) throw new Error("fetchPage called too many times");
      return Promise.resolve(pages[idx++]);
    };
    const requestedPageSize = 2;
    const items = await drain(paginate(fetchPage, OFFSET_PLAN, requestedPageSize));
    expect(items).toEqual(["a", "b", "c"]);
    // MUST be exactly 2 calls; without the fix it would never stop on partial page
    expect(calls).toHaveLength(2);
  });

  test("Bug 2b — requestedPageSize undefined: stops only when page is empty (2 calls)", async () => {
    // When no requestedPageSize is supplied the engine must fall back to
    // stopping on an empty page only.
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { items: ["a"] }, // non-empty → continue
      { items: [] },    // empty → stop
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      if (idx >= pages.length) throw new Error("fetchPage called too many times");
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, OFFSET_PLAN, undefined));
    expect(items).toEqual(["a"]);
    expect(calls).toHaveLength(2);
  });
});

describe("paginate() runtime — page style (1-based)", () => {
  const PAGE_PLAN: PaginatePlan = {
    style: "page",
    requestParam: "page",
    pageSizeParam: "per_page",
    itemsField: "data",
    nextField: null,
    opId: "op_page",
  };

  test("Fix 1 — page style: first fetch sends page=1 (not page=0)", async () => {
    // GitHub/GitLab page-style APIs are 1-based. Counter must start at 1 for
    // page style (not 0 which would either 4xx or duplicate the first page).
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { data: ["a", "b"] }, // full page → continue
      { data: ["c"] },       // partial page (< per_page=2) → stop
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      if (idx >= pages.length) throw new Error("fetchPage called too many times");
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, PAGE_PLAN, 2));
    expect(items).toEqual(["a", "b", "c"]);
    // CRITICAL: sequence must be [{page:1},{page:2}], NOT [{page:0},{page:1}]
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ page: 1 });
    expect(calls[1]).toEqual({ page: 2 });
  });

  test("page style: 3-page sequence uses [{page:1},{page:2},{page:3}] (not 0-based)", async () => {
    // Exhaustive: full 2 pages then short page; recorded pageArgs must be 1-based.
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      { data: [1, 2] }, // full page → continue
      { data: [3, 4] }, // full page → continue
      { data: [5] },    // partial page → stop
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      if (idx >= pages.length) throw new Error("fetchPage called too many times");
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, PAGE_PLAN, 2));
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ page: 1 });
    expect(calls[1]).toEqual({ page: 2 });
    expect(calls[2]).toEqual({ page: 3 });
  });

  test("offset style: counter still starts at 0 (offset is 0-based, unaffected by fix)", async () => {
    // Confirm the fix does NOT change offset-style — offset starts at 0.
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    const OFFSET_PLAN_CHECK: PaginatePlan = {
      style: "offset",
      requestParam: "offset",
      pageSizeParam: "limit",
      itemsField: "items",
      nextField: null,
      opId: "op_offset_check",
    };
    const pages = [
      { items: ["x", "y"] }, // full page → continue
      { items: ["z"] },       // partial page → stop
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      if (idx >= pages.length) throw new Error("fetchPage called too many times");
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, OFFSET_PLAN_CHECK, 2));
    expect(items).toEqual(["x", "y", "z"]);
    // Offset starts at 0, then increments by items.length (2) → next is 2
    expect(calls[0]).toEqual({ offset: 0 });
    expect(calls[1]).toEqual({ offset: 2 });
  });
});

// ─── Dot-path: emitted engine source ─────────────────────────────────────────

describe("generatePaginationModule — dot-path engine emission", () => {
  test("emits a getPath helper function", () => {
    const src = generatePaginationModule();
    expect(src).toMatch(/function\s+getPath/);
  });

  test("getPath splits on '.' and walks the object", () => {
    const src = generatePaginationModule();
    expect(src).toContain('split(".")');
  });


});

// ─── Dot-path runtime: envelope cursor iteration ─────────────────────────────

describe("paginate() runtime — envelope cursor (dot-path itemsField + nextField)", () => {
  const ENVELOPE_CURSOR_PLAN: PaginatePlan = {
    style: "cursor",
    requestParam: "cursor",
    pageSizeParam: null,
    itemsField: "data.results",
    nextField: "data.next_cursor",
    opId: "op_envelope",
  };

  test("3-page envelope cursor: yields all items from nested 'data.results', stops on null next_cursor", async () => {
    const paginate = loadEmittedPaginate();
    const calls: Array<Record<string, unknown>> = [];
    // Server returns envelope: { data: { results: [...], next_cursor: "..." } }
    const pages = [
      { data: { results: [1, 2], next_cursor: "p2" } },
      { data: { results: [3, 4], next_cursor: "p3" } },
      { data: { results: [5], next_cursor: null } },
    ];
    let idx = 0;
    const fetchPage = (pageArgs: Record<string, unknown>): Promise<unknown> => {
      calls.push({ ...pageArgs });
      return Promise.resolve(pages[idx++]);
    };
    const items = await drain(paginate(fetchPage, ENVELOPE_CURSOR_PLAN));
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect(calls).toHaveLength(3);
    expect(calls[1]).toEqual({ cursor: "p2" });
    expect(calls[2]).toEqual({ cursor: "p3" });
  });

  test("missing envelope mid-stream throws typed error naming itemsField", async () => {
    const paginate = loadEmittedPaginate();
    const pages = [
      { data: { results: [1], next_cursor: "p2" } },
      { not_data: "wrong" }, // envelope gone on page 2 → TypeError
    ];
    let idx = 0;
    const fetchPage = (): Promise<unknown> => Promise.resolve(pages[idx++]);
    await expect(drain(paginate(fetchPage, ENVELOPE_CURSOR_PLAN))).rejects.toThrow(TypeError);
  });
});

// ─── Dot-path: single-segment behavior identical ─────────────────────────────

describe("paginate() runtime — single-segment path is byte-equivalent (regression)", () => {
  const FLAT_CURSOR_PLAN: PaginatePlan = {
    style: "cursor",
    requestParam: "cursor",
    pageSizeParam: null,
    itemsField: "data",
    nextField: "next_cursor",
    opId: "op_flat_regression",
  };

  test("single-segment itemsField 'data' still works after getPath migration", async () => {
    const paginate = loadEmittedPaginate();
    const pages = [
      { data: ["a", "b"], next_cursor: "p2" },
      { data: ["c"], next_cursor: null },
    ];
    let idx = 0;
    const fetchPage = (): Promise<unknown> => Promise.resolve(pages[idx++]);
    const items = await drain(paginate(fetchPage, FLAT_CURSOR_PLAN));
    expect(items).toEqual(["a", "b", "c"]);
  });
});

// ─── Literal-dot key: top-level prop named "page.items" paginates correctly ────

describe("paginate() runtime — literal-key-first (C1 false-positive fix)", () => {
  const LITERAL_DOT_PLAN: PaginatePlan = {
    style: "cursor",
    requestParam: "cursor",
    pageSizeParam: null,
    itemsField: "page.items",
    nextField: "page.cursor",
    opId: "op_literal_dot",
  };

  test("literal dot key: prop named 'page.items' (with dot) is read as own property, not descended", async () => {
    // The server response has a top-level property whose NAME contains a dot.
    // getPath must prefer the literal key over splitting on ".".
    const paginate = loadEmittedPaginate();
    const pages = [
      { "page.items": ["x", "y"], "page.cursor": "next1" },
      { "page.items": ["z"], "page.cursor": null },
    ];
    let idx = 0;
    const fetchPage = (): Promise<unknown> => Promise.resolve(pages[idx++]);
    const items = await drain(paginate(fetchPage, LITERAL_DOT_PLAN));
    expect(items).toEqual(["x", "y", "z"]);
  });

  test("literal dot key: benign path 'data' (no dot) — behavior byte-identical to before C1", async () => {
    const paginate = loadEmittedPaginate();
    const pages = [
      { data: [1, 2], next_cursor: "p2" },
      { data: [3], next_cursor: null },
    ];
    let idx = 0;
    const fetchPage = (): Promise<unknown> => Promise.resolve(pages[idx++]);
    const items = await drain(paginate(fetchPage, {
      style: "cursor",
      requestParam: "cursor",
      pageSizeParam: null,
      itemsField: "data",
      nextField: "next_cursor",
      opId: "op_benign",
    }));
    expect(items).toEqual([1, 2, 3]);
  });
});
