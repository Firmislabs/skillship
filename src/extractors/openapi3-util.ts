// stableId is now canonical in src/shared/stable-id.ts; re-exported here so
// the ~12 extractor call sites need no changes.
export { stableId } from "../shared/stable-id.js";

export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
