// src/shared/oas-schema.ts
// Shared OAS schema predicates used by both extractors and renderers.

/**
 * Returns true when the schema is object-like: either it explicitly declares
 * `type: "object"` OR it has a `properties` map and no `type` keyword.
 *
 * OAS 3.1 §4.8.24 makes `type: "object"` optional when `properties` is
 * present, so this predicate covers both the explicit and implicit cases.
 * Arrays and primitives (which lack a meaningful `properties` map) return false.
 */
export function isObjectLikeSchema(s: {
  type?: unknown;
  properties?: unknown;
}): boolean {
  return (
    s.type === "object" ||
    (s.properties !== undefined && s.type === undefined)
  );
}

const REF_PREFIX = "#/components/schemas/";

/**
 * Recursively walks a JSON value and returns all `#/components/schemas/<Name>`
 * strings found in `$ref` fields, deduplicated, sorted alphabetically.
 *
 * Used by buildResponses in oas.ts to register stubs for nested refs inside
 * inline schema_json payloads so the synthetic OAS document has no dangling refs.
 */
export function collectNestedSchemaRefs(value: unknown): string[] {
  const found = new Set<string>();
  walkRefs(value, found);
  return [...found].sort();
}

function walkRefs(value: unknown, acc: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkRefs(item, acc);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(obj)) {
    if (key === "$ref" && typeof child === "string" && child.startsWith(REF_PREFIX)) {
      acc.add(child.slice(REF_PREFIX.length));
    } else {
      walkRefs(child, acc);
    }
  }
}
