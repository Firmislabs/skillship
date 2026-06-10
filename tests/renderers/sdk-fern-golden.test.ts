// Pure Node, NO Docker. Two layers:
//  (1) manifest integrity: recompute sha256 of every committed file, compare to
//      the committed <tree>.manifest.json (catches hand-edits / partial drift).
//  (2) structural + no-leakage: required marker file present; no op_<hex>
//      leakage anywhere in the tree.
//  (3) agent-specific structural pins: oauth_token_provider.rs IS present in the
//      rust agent tree (Fern emits native oauth2 client-credentials machinery from
//      the OAS oauth2 securityScheme + flows; the auth-schemes overlay path is
//      dormant — see KNOWN_GAPS.md); client.py exposes the token callable-union.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fernTreeName, type GoldenFixture } from "./sdk-fern-golden-helpers.js";
import type { FernLang } from "../../src/renderers/fern-images.js";

const ROOT = join(process.cwd(), "tests/fixtures/golden");
// NOTE: Fern's Python generator (local-file-system mode) emits a FLAT package
// with NO pyproject.toml — the root marker is __init__.py. Rust has Cargo.toml.
// Record<FernLang, string> makes this exhaustive: adding a language to the
// FernLang union forces a marker here (compile error otherwise), and fernTreeName
// (the single source of truth for tree names) auto-generates its tree dirs below.
const LANG_MARKERS: Record<FernLang, string> = {
  python: "__init__.py",
  rust: "Cargo.toml",
};
const FIXTURES: readonly GoldenFixture[] = ["rest", "graphql", "agent"];
const TREES: { dir: string; marker: string }[] = (
  Object.keys(LANG_MARKERS) as FernLang[]
).flatMap((lang) =>
  FIXTURES.map((fixture) => ({
    dir: fernTreeName(lang, fixture),
    marker: LANG_MARKERS[lang],
  })),
);

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
      const raw = readFileSync(`${treeDir}.manifest.json`, "utf8");
      const manifest = JSON.parse(raw) as Record<string, string>;
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

// Agent-fixture-specific structural pins (dormant-OAuth reality lock).
// These run after the main loop so they are clearly labelled.
describe("Fern SDK agent golden — structural pins", () => {
  test("sdk-python-agent-minimal: __init__.py present (python root marker)", () => {
    const treeDir = join(ROOT, "sdk-python-agent-minimal");
    expect(existsSync(join(treeDir, "__init__.py")), "__init__.py missing").toBe(true);
  });

  test("sdk-rust-agent-minimal: Cargo.toml present (rust root marker)", () => {
    const treeDir = join(ROOT, "sdk-rust-agent-minimal");
    expect(existsSync(join(treeDir, "Cargo.toml")), "Cargo.toml missing").toBe(true);
  });

  // Truthfulness pin: oauth_token_provider.rs IS present because Fern's Rust
  // generator emits its native OAuth machinery (OAuthTokenProvider, OAuthConfig,
  // client_credentials fetch) from the OAS oauth2 securityScheme + flows alone —
  // NOT from our auth-schemes overlay in generators.yml. The auth-schemes overlay
  // path is dormant (gated on request-body projection; see KNOWN_GAPS.md), so
  // generators.yml carries NO auth-schemes block — yet the file appears because
  // the upstream generator handles oauth2 client-credentials natively. This pin
  // records the actual generated reality so future changes can't silently regress it.
  test("sdk-rust-agent-minimal: oauth_token_provider.rs present (Fern-native oauth2 client-credentials — not overlay-driven)", () => {
    const treeDir = join(ROOT, "sdk-rust-agent-minimal");
    const files = listRel(treeDir);
    const hasProvider = files.some((f) => f.includes("oauth_token_provider"));
    expect(
      hasProvider,
      "oauth_token_provider.rs must be present (generated from oauth2 securityScheme + flows, not auth-schemes overlay)",
    ).toBe(true);
  });

  // Python analog: client.py exposes token as str | Callable union (+async_token on AsyncClient).
  // This pin confirms the Fern Python generator emits the callable-union token pattern
  // for oauth2 client-credentials — the Python counterpart of the Rust OAuth machinery pin.
  test("sdk-python-agent-minimal: client.py exposes token as str | Callable union", () => {
    const clientPy = readFileSync(
      join(ROOT, "sdk-python-agent-minimal", "client.py"),
      "utf8",
    );
    expect(
      clientPy,
      "client.py must expose token: Optional[Union[str, Callable[[], str]]]",
    ).toContain("typing.Union[str, typing.Callable[[], str]]");
  });
});
