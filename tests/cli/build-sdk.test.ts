import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";

const FIXTURE_SPEC = readFileSync(
  join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"),
  "utf8",
);

function stageProject(): { inDir: string; outDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sk-build-sdk-"));
  const inDir = join(root, "in");
  const outDir = join(root, "out");
  mkdirSync(join(inDir, ".skillship/sources"), { recursive: true });
  const sha = createHash("sha256").update(FIXTURE_SPEC).digest("hex");
  writeFileSync(
    join(inDir, ".skillship/sources", `${sha}.yaml`),
    FIXTURE_SPEC,
    "utf8",
  );
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
  return {
    inDir,
    outDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("runBuild — SDK emission", () => {
  test("emits {outDir}/{product-slug}/sdk/ with package.json by default", async () => {
    const { inDir, outDir, cleanup } = stageProject();
    try {
      const result = await runBuild({ in: inDir, out: outDir });
      const sdkDir = join(outDir, "min-example", "sdk");
      const pkgPath = join(sdkDir, "package.json");
      expect(statSync(pkgPath).isFile()).toBe(true);
      const pkgRaw = readFileSync(pkgPath, "utf8");
      const pkg = JSON.parse(pkgRaw) as { type?: string };
      expect(pkg.type).toBe("module");
      expect(result.artifacts.some((a) => a.path === pkgPath)).toBe(true);
    } finally {
      cleanup();
    }
  }, 60000);

  test("--skip-sdk short-circuits SDK emission without affecting other artifacts", async () => {
    const { inDir, outDir, cleanup } = stageProject();
    try {
      const result = await runBuild({ in: inDir, out: outDir, skipSdk: true });
      const sdkDir = join(outDir, "min-example", "sdk");
      expect(() => statSync(sdkDir)).toThrow();
      const skillPath = join(outDir, "min-example", "SKILL.md");
      expect(statSync(skillPath).isFile()).toBe(true);
      expect(result.artifacts.some((a) => a.path === skillPath)).toBe(true);
      expect(result.artifacts.every((a) => !a.path.includes("/sdk/"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30000);
});
