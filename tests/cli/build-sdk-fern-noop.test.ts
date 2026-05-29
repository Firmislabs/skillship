// Verifies the build wiring treats absent/empty fernLangs as a pure no-op:
// no Docker, no sdk-python/ dir. (Full Docker generation is covered by the
// golden tasks + the Docker CI lane.)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";

const FIXTURE_SPEC = readFileSync(
  join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"),
  "utf8",
);

// Copy of stageProject() from tests/cli/build-sdk.test.ts (keep in sync).
function stageProject(): { inDir: string; outDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sk-build-fern-noop-"));
  const inDir = join(root, "in");
  const outDir = join(root, "out");
  mkdirSync(join(inDir, ".skillship/sources"), { recursive: true });
  const sha = createHash("sha256").update(FIXTURE_SPEC).digest("hex");
  writeFileSync(join(inDir, ".skillship/sources", `${sha}.yaml`), FIXTURE_SPEC, "utf8");
  const cfg = `product:
  domain: min.example
  github_org: null
sources:
  - url: https://min.example/openapi.yaml
    surface: rest
    sha256: ${sha}
    content_type: application/openapi+yaml
    fetched_at: 2026-05-20T00:00:00.000Z
coverage: bronze
`;
  writeFileSync(join(inDir, ".skillship/config.yaml"), cfg, "utf8");
  return { inDir, outDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("build wiring: fernLangs no-op", () => {
  test("omitting fernLangs produces no sdk-python/ or sdk-rust/", async () => {
    const { inDir, outDir, cleanup } = stageProject();
    try {
      await runBuild({ in: inDir, out: outDir });
      const skillDir = join(outDir, "min-example");
      expect(existsSync(join(skillDir, "sdk-python"))).toBe(false);
      expect(existsSync(join(skillDir, "sdk-rust"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
