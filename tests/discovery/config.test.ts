import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  buildConfig,
  scoreCoverage,
  writeConfig,
  type SkillshipConfig,
} from "../../src/discovery/config.js";
import { makeTmpCtx } from "../helpers.js";

describe("scoreCoverage", () => {
  it("<5 → bronze", () => {
    expect(scoreCoverage(0)).toBe("bronze");
    expect(scoreCoverage(4)).toBe("bronze");
  });
  it("5..9 → silver", () => {
    expect(scoreCoverage(5)).toBe("silver");
    expect(scoreCoverage(9)).toBe("silver");
  });
  it(">=10 → gold", () => {
    expect(scoreCoverage(10)).toBe("gold");
    expect(scoreCoverage(42)).toBe("gold");
  });
});

describe("buildConfig", () => {
  it("assembles product + sources + derived coverage", () => {
    const cfg = buildConfig({
      domain: "supabase.com",
      github_org: "supabase",
      sources: [
        {
          surface: "rest",
          url: "https://api.supabase.com/openapi.json",
          sha256: "abc",
          content_type: "application/json",
          fetched_at: "2026-04-23T00:00:00.000Z",
        },
        {
          surface: "llms_txt",
          url: "https://supabase.com/llms.txt",
          sha256: "def",
          content_type: "text/plain",
          fetched_at: "2026-04-23T00:00:00.000Z",
        },
      ],
    });
    expect(cfg.product.domain).toBe("supabase.com");
    expect(cfg.product.github_org).toBe("supabase");
    expect(cfg.sources).toHaveLength(2);
    expect(cfg.coverage).toBe("bronze");
  });

  it("handles a null github_org", () => {
    const cfg = buildConfig({
      domain: "example.com",
      github_org: null,
      sources: [],
    });
    expect(cfg.product.github_org).toBeNull();
  });

  it("emits GOLD coverage at 10+ sources", () => {
    const sources = Array.from({ length: 11 }, (_, i) => ({
      surface: "rest" as const,
      url: `https://example.com/${i}`,
      sha256: `sha-${i}`,
      content_type: "application/json",
      fetched_at: "2026-04-23T00:00:00.000Z",
    }));
    const cfg = buildConfig({
      domain: "example.com",
      github_org: null,
      sources,
    });
    expect(cfg.coverage).toBe("gold");
  });
});

describe("writeConfig", () => {
  it("writes valid YAML that parses back to the same shape", () => {
    const ctx = makeTmpCtx();
    try {
      const cfg: SkillshipConfig = {
        product: { domain: "supabase.com", github_org: "supabase" },
        sources: [
          {
            surface: "rest",
            url: "https://api.supabase.com/api/v1/openapi.json",
            sha256:
              "a".repeat(64),
            content_type: "application/json",
            fetched_at: "2026-04-23T12:00:00.000Z",
          },
        ],
        coverage: "silver",
      };
      const outPath = join(ctx.dir, ".skillship", "config.yaml");
      writeConfig(outPath, cfg);
      const text = readFileSync(outPath, "utf8");
      const parsed = parseYaml(text) as SkillshipConfig;
      expect(parsed.product.domain).toBe("supabase.com");
      expect(parsed.product.github_org).toBe("supabase");
      expect(parsed.sources).toHaveLength(1);
      expect(parsed.sources[0]?.surface).toBe("rest");
      expect(parsed.sources[0]?.sha256).toBe("a".repeat(64));
      expect(parsed.coverage).toBe("silver");
    } finally {
      ctx.cleanup();
    }
  });
});
