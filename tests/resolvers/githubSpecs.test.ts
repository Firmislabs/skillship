import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  resolveGithubSpecs,
  type GithubBlob,
  type GithubRepoFetcher,
} from "../../src/resolvers/githubSpecs.js";
import type { ConfigSourceEntry } from "../../src/discovery/config.js";

const FIXED_NOW = "2026-04-23T00:00:00.000Z";

function mockFetcher(map: Record<string, GithubBlob[]>): GithubRepoFetcher {
  return async (url) => map[url] ?? [];
}

function entry(
  surface: ConfigSourceEntry["surface"],
  url: string,
  contentType: string,
): ConfigSourceEntry {
  return {
    surface,
    url,
    sha256: createHash("sha256").update(url).digest("hex"),
    content_type: contentType,
    fetched_at: FIXED_NOW,
  };
}

describe("resolveGithubSpecs", () => {
  test("non-github.repo entries pass through unchanged", async () => {
    const inputs: ConfigSourceEntry[] = [
      entry("docs", "https://supa.example/sitemap.xml", "application/xml"),
      entry(
        "llms_txt",
        "https://supa.example/llms.txt",
        "text/plain",
      ),
    ];
    const result = await resolveGithubSpecs(inputs, mockFetcher({}), {
      now: () => FIXED_NOW,
    });
    expect(result).toEqual(inputs);
  });

  test("expands a github.repo with one openapi.yaml into one rest entry", async () => {
    const repoUrl = "https://github.com/supa/openapi";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const bytes = Buffer.from("openapi: 3.0.0\ninfo:\n  title: x\n");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [{ path: "openapi.yaml", bytes }],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(1);
    const r = result[0]!;
    expect(r.surface).toBe("rest");
    expect(r.content_type).toBe("application/openapi+yaml");
    expect(r.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(r.url).toBe(`${repoUrl}/blob/HEAD/openapi.yaml`);
    expect(r.fetched_at).toBe(FIXED_NOW);
  });

  test("emits one entry per spec file in a multi-spec repo", async () => {
    const repoUrl = "https://github.com/supa/specs";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          { path: "openapi.yaml", bytes: Buffer.from("a") },
          { path: "swagger.json", bytes: Buffer.from("{}") },
          { path: "README.md", bytes: Buffer.from("# readme") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(2);
    const cts = result.map((r) => r.content_type).sort();
    expect(cts).toEqual([
      "application/openapi+yaml",
      "application/swagger+json",
    ]);
  });

  test("classifies cli + sdk spec files correctly", async () => {
    const cliRepo = "https://github.com/supa/cli";
    const sdkRepo = "https://github.com/supa/supabase-js";
    const ph1 = entry("cli", cliRepo, "application/vnd.github.repo");
    const ph2 = entry("sdk", sdkRepo, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph1, ph2],
      mockFetcher({
        [cliRepo]: [{ path: "openref/cli/cli.yaml", bytes: Buffer.from("c") }],
        [sdkRepo]: [
          { path: "openref/supa-js.yaml", bytes: Buffer.from("s") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    const bySurface = new Map(result.map((r) => [r.surface, r.content_type]));
    expect(bySurface.get("cli")).toBe("application/x-openref-cli+yaml");
    expect(bySurface.get("sdk")).toBe("application/x-openref-sdk+yaml");
  });

  test("drops a github.repo entry that has no recognised spec files", async () => {
    const repoUrl = "https://github.com/supa/website";
    const ph = entry("docs", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          { path: "README.md", bytes: Buffer.from("# x") },
          { path: "src/index.ts", bytes: Buffer.from("export {}") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toEqual([]);
  });

  test("recognises *openapi*.json and prefixed openapi files (monorepo layouts)", async () => {
    const repoUrl = "https://github.com/supabase/supabase";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          {
            path: "apps/docs/spec/api_v1_openapi.json",
            bytes: Buffer.from("{}"),
          },
          {
            path: "apps/docs/spec/auth_v1_openapi.json",
            bytes: Buffer.from("{}"),
          },
          { path: "apps/web/package.json", bytes: Buffer.from("{}") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r.content_type).toBe("application/openapi+json");
      expect(r.surface).toBe("rest");
    }
  });

  test("recognises openapi.json and swagger.yaml variants", async () => {
    const repoUrl = "https://github.com/supa/api";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          { path: "spec/openapi.json", bytes: Buffer.from("{}") },
          { path: "spec/swagger.yaml", bytes: Buffer.from("a: 1") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    const cts = result.map((r) => r.content_type).sort();
    expect(cts).toEqual([
      "application/openapi+json",
      "application/swagger+yaml",
    ]);
  });

  test("rejects CI/GHA workflow, test, and snapshot paths even when filename matches", async () => {
    const repoUrl = "https://github.com/acme/api";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          {
            path: ".github/openapi-problem-matcher.json",
            bytes: Buffer.from("{}"),
          },
          {
            path: ".github/workflows/ci-openapi-codegen.yml",
            bytes: Buffer.from("{}"),
          },
          {
            path: "services/mcp/tests/unit/__snapshots__/endpoint-openapi-spec.json",
            bytes: Buffer.from("{}"),
          },
          {
            path: "examples/openapi-demo.yaml",
            bytes: Buffer.from("{}"),
          },
          {
            path: "fixtures/openapi.yaml",
            bytes: Buffer.from("{}"),
          },
          {
            path: "spec/openapi.yaml",
            bytes: Buffer.from("a: 1"),
          },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe(`${repoUrl}/blob/HEAD/spec/openapi.yaml`);
  });

  test("classifies .graphql files as application/graphql with rest surface", async () => {
    const repoUrl = "https://github.com/linear/linear";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          { path: "packages/sdk/src/schema.graphql", bytes: Buffer.from("type Query { me: User }") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.content_type).toBe("application/graphql");
    expect(result[0]?.surface).toBe("rest");
  });

  test("classifies .gql files as application/graphql", async () => {
    const repoUrl = "https://github.com/acme/api";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          { path: "api/schema.gql", bytes: Buffer.from("type Query { ping: String }") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.content_type).toBe("application/graphql");
  });

  test("mixes graphql and openapi specs in the same repo", async () => {
    const repoUrl = "https://github.com/acme/mixed";
    const ph = entry("rest", repoUrl, "application/vnd.github.repo");
    const result = await resolveGithubSpecs(
      [ph],
      mockFetcher({
        [repoUrl]: [
          { path: "schema.graphql", bytes: Buffer.from("type Query { x: String }") },
          { path: "openapi.yaml", bytes: Buffer.from("openapi: 3.0.0") },
        ],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(2);
    const cts = result.map(r => r.content_type).sort();
    expect(cts).toEqual(["application/graphql", "application/openapi+yaml"]);
  });

  test("preserves order: pass-through entries keep their position around expansions", async () => {
    const ghRepo = "https://github.com/supa/openapi";
    const ph = entry("rest", ghRepo, "application/vnd.github.repo");
    const before = entry(
      "llms_txt",
      "https://supa.example/llms.txt",
      "text/plain",
    );
    const after = entry(
      "docs",
      "https://supa.example/sitemap.xml",
      "application/xml",
    );
    const result = await resolveGithubSpecs(
      [before, ph, after],
      mockFetcher({
        [ghRepo]: [{ path: "openapi.yaml", bytes: Buffer.from("a") }],
      }),
      { now: () => FIXED_NOW },
    );
    expect(result).toHaveLength(3);
    expect(result[0]?.url).toBe(before.url);
    expect(result[1]?.content_type).toBe("application/openapi+yaml");
    expect(result[2]?.url).toBe(after.url);
  });
});
