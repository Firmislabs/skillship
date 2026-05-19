// tests/cli/build-oas.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";

describe("runBuild emits openapi.json", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sk-build-oas-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes a valid OpenAPI 3.1 artifact", async () => {
    const sk = join(dir, ".skillship");
    mkdirSync(join(sk, "sources"), { recursive: true });
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(join(sk, "sources", `${sha}.yaml`), bytes);
    writeFileSync(join(sk, "config.yaml"), [
      "product: { domain: min.example, github_org: null }",
      "sources:",
      `  - { surface: rest, url: 'https://min.example/openapi.yaml', sha256: ${sha}, content_type: 'application/openapi+yaml', fetched_at: '2026-05-19T12:00:00.000Z' }`,
      "coverage: bronze",
    ].join("\n"));
    const res = await runBuild({ in: dir, out: join(dir, "skills") });
    const oasPath = res.artifacts.find(a => a.path.endsWith("openapi.json"))?.path;
    expect(oasPath).toBeDefined();
    expect(existsSync(oasPath!)).toBe(true);
    const doc = JSON.parse(readFileSync(oasPath!, "utf8"));
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/projects"]).toBeDefined();
  });
});
