// src/shared/annotations.ts
// Canonical annotation key↔field mapping shared by extractors and renderers.
// Single source of truth: any new annotation field is added here once and
// automatically propagates to all consumers.

/** The OAS extension key used to carry per-operation annotations. */
export const ANNOTATION_EXTENSION_KEY = "x-skillship-annotations" as const;

/**
 * Canonical pairs: [extensionKey, graphField].
 * - extensionKey: the key inside x-skillship-annotations in OAS.
 * - graphField:   the claim field name stored in the graph.
 *
 * Typed as readonly tuples so callers can iterate without mutation.
 */
export const ANNOTATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["destructive", "is_destructive"],
  ["readOnly", "is_read_only"],
  ["idempotent", "is_idempotent"],
] as const;
