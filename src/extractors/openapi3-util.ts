import { createHash } from "node:crypto";

export function stableId(prefix: string, parts: (string | number)[]): string {
  const h = createHash("sha1")
    .update(parts.map(String).join("\x00"))
    .digest("hex")
    .slice(0, 16);
  return `${prefix}_${h}`;
}

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
