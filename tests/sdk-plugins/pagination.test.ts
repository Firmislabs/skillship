// tests/sdk-plugins/pagination.test.ts
// TDD RED phase: assertions for the pagination engine emitter.
// Step 1: failing tests (module does not exist yet).

import { describe, expect, test } from "vitest";
import { generatePaginationModule } from "../../src/sdk-plugins/pagination.js";

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

  test("emits the repeated-cursor guard (stop when next === prev)", () => {
    const src = generatePaginationModule();
    // The guard must catch repeated cursors to prevent infinite loops
    expect(src).toMatch(/next\s*===\s*prev/);
  });

  test("emits cursor stop condition: null/missing/empty next value", () => {
    const src = generatePaginationModule();
    // Cursor: stop when next is null, undefined, or empty string
    expect(src).toContain("cursor");
    // The condition should cover null/missing (falsy check or explicit checks)
    expect(src).toMatch(/next\s*==\s*null|next\s*===\s*null|!next|next\s*===\s*undefined/);
  });

  test("emits offset/page stop condition: page yields fewer items than requested or zero", () => {
    const src = generatePaginationModule();
    // Must have logic comparing items.length to page size, or stopping on empty
    expect(src).toMatch(/items\.length\s*[<=>]|items\.length\s*===\s*0|items\.length\s*<\s*|length\s*===\s*0/);
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
