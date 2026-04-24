import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";
import { makeTmpCtx, type TmpCtx } from "../helpers.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const VALIDATOR = join(
  process.cwd(),
  "vendor/anthropic-skills/quick_validate.py",
);

interface SeedSource {
  readonly surface: SkillshipConfig["sources"][number]["surface"];
  readonly url: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly ext: string;
}

const NOW = "2026-04-23T12:00:00.000Z";

function seedProject(dir: string, sources: SeedSource[], domain: string): void {
  const skDir = join(dir, ".skillship");
  const srcDir = join(skDir, "sources");
  mkdirSync(srcDir, { recursive: true });
  const entries = sources.map((s) => {
    const sha = createHash("sha256").update(s.bytes).digest("hex");
    writeFileSync(join(srcDir, `${sha}.${s.ext}`), s.bytes);
    return {
      surface: s.surface,
      url: s.url,
      sha256: sha,
      content_type: s.contentType,
      fetched_at: NOW,
    };
  });
  const config = {
    product: { domain, github_org: null },
    sources: entries,
    coverage: "bronze" as const,
  };
  writeFileSync(join(skDir, "config.yaml"), stringifyYaml(config), "utf8");
}

function loadFixture(rel: string): Buffer {
  return readFileSync(join(process.cwd(), rel));
}

describe("Phase 4 acceptance — skillship build passes quick_validate.py", () => {
  let ctx: TmpCtx;
  beforeEach(() => {
    ctx = makeTmpCtx("skillship-p4-");
  });
  afterEach(() => {
    ctx.cleanup();
  });

  test("quick_validate.py exists in vendor tree", () => {
    expect(existsSync(VALIDATOR)).toBe(true);
  });

  test("built skill directory passes quick_validate.py", async () => {
    seedProject(
      ctx.dir,
      [
        {
          surface: "rest",
          url: "https://acme.example/openapi.yaml",
          contentType: "application/openapi+yaml",
          bytes: loadFixture("tests/fixtures/openapi3/minimal.yaml"),
          ext: "yaml",
        },
        {
          surface: "llms_txt",
          url: "https://acme.example/llms.txt",
          contentType: "text/plain; charset=utf-8",
          bytes: loadFixture("tests/fixtures/llms-txt/supa.txt"),
          ext: "txt",
        },
        {
          surface: "mcp",
          url: "https://acme.example/.well-known/oauth-protected-resource/mcp",
          contentType: "application/json",
          bytes: loadFixture("tests/fixtures/mcp-well-known/sample.json"),
          ext: "json",
        },
      ],
      "acme.example",
    );
    const outDir = join(ctx.dir, "dist");
    await runBuild({ in: ctx.dir, out: outDir });
    const skillDir = join(outDir, "acme-example");
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    const stdout = execFileSync("python3", [VALIDATOR, skillDir], {
      encoding: "utf8",
    });
    expect(stdout.trim()).toBe("Skill is valid!");
  });

  test("validator rejects missing SKILL.md", () => {
    const emptyDir = join(ctx.dir, "empty");
    mkdirSync(emptyDir, { recursive: true });
    expect(() =>
      execFileSync("python3", [VALIDATOR, emptyDir], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ).toThrow();
  });
});
