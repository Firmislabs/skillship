// src/sdk-plugins/mcp-server-lit.ts
// Shared string-literal helper for the mcp-server emitter family
// (mcp-server-emit.ts + mcp-server-dispatch.ts). Kept in its own module so both
// emitter halves depend on one source of truth and neither file grows past the
// 300-line house rule.

/**
 * Produce a double-quoted TS/JSON string literal for a baked value. Using
 * JSON.stringify guarantees backslashes, quotes, and control characters are
 * escaped so the literal is safe to splice into the emitted template.
 */
export function lit(s: string): string {
  return JSON.stringify(s);
}
