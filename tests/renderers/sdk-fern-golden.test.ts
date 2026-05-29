// Pure Node, NO Docker. Two layers:
//  (1) manifest integrity: recompute sha256 of every committed file, compare to
//      the committed <tree>.manifest.json (catches hand-edits / partial drift).
//  (2) structural + no-leakage: required marker file present; no op_<hex>
//      leakage anywhere in the tree.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(process.cwd(), "tests/fixtures/golden");
// NOTE: Fern's Python generator (local-file-system mode) emits a FLAT package
// with NO pyproject.toml — the root marker is __init__.py. Rust has Cargo.toml.
const TREES: { dir: string; marker: string }[] = [
  { dir: "sdk-python-minimal", marker: "__init__.py" },
  { dir: "sdk-rust-minimal", marker: "Cargo.toml" },
  { dir: "sdk-python-graphql-minimal", marker: "__init__.py" },
  { dir: "sdk-rust-graphql-minimal", marker: "Cargo.toml" },
];

function listRel(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listRel(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}

describe("Fern SDK golden lock (pure Node)", () => {
  for (const { dir, marker } of TREES) {
    const treeDir = join(ROOT, dir);
    test(`${dir}: manifest integrity`, () => {
      const manifest = JSON.parse(readFileSync(`${treeDir}.manifest.json`, "utf8")) as Record<string, string>;
      const files = listRel(treeDir);
      expect(files).toEqual(Object.keys(manifest).sort());
      for (const rel of files) {
        const got = createHash("sha256").update(readFileSync(join(treeDir, rel))).digest("hex");
        expect(got, `manifest mismatch in ${dir}/${rel}`).toBe(manifest[rel]);
      }
    });
    test(`${dir}: structural + no leakage`, () => {
      expect(existsSync(join(treeDir, marker)), `${marker} missing`).toBe(true);
      for (const rel of listRel(treeDir)) {
        const body = readFileSync(join(treeDir, rel), "utf8");
        expect(body, `op_<hex> leak in ${rel}`).not.toMatch(/op_[0-9a-f]{6,}/);
      }
    });
  }
});
