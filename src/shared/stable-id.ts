// src/shared/stable-id.ts
// Canonical stableId function: deterministic SHA-1-based node ID generation.
// Moved from src/extractors/openapi3-util.ts so renderers can import it
// without creating a renderers→extractors dependency edge.
import { createHash } from "node:crypto";

/**
 * Derives a stable, deterministic node ID by hashing the given parts.
 * The prefix distinguishes node kinds (op_, par_, rsp_, sfc_, etc.) for
 * readability; the hash covers the full parts array joined with NUL bytes.
 */
export function stableId(prefix: string, parts: (string | number)[]): string {
  const h = createHash("sha1")
    .update(parts.map(String).join("\x00"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${h}`;
}
