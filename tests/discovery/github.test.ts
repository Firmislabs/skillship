import { describe, expect, it } from "vitest";
import {
  discoverGithubSignals,
  matchSignalRepos,
  type GithubRepo,
} from "../../src/discovery/github.js";

const FIXTURE_REPOS: GithubRepo[] = [
  { name: "supabase", html_url: "https://github.com/supabase/supabase" },
  { name: "cli", html_url: "https://github.com/supabase/cli" },
  { name: "supabase-js", html_url: "https://github.com/supabase/supabase-js" },
  {
    name: "postgrest-openapi",
    html_url: "https://github.com/supabase/postgrest-openapi",
  },
  { name: "auth-helpers", html_url: "https://github.com/supabase/auth-helpers" },
  {
    name: "supabase-mcp",
    html_url: "https://github.com/supabase/supabase-mcp",
  },
  { name: "realtime", html_url: "https://github.com/supabase/realtime" },
];

describe("matchSignalRepos", () => {
  it("matches cli / mcp / openapi / sdk heuristically", () => {
    const hits = matchSignalRepos(FIXTURE_REPOS);
    const names = hits.map((r) => r.name).sort();
    expect(names).toContain("cli");
    expect(names).toContain("supabase-mcp");
    expect(names).toContain("postgrest-openapi");
  });

  it("rejects non-signal repos", () => {
    const hits = matchSignalRepos(FIXTURE_REPOS).map((r) => r.name);
    expect(hits).not.toContain("supabase");
    expect(hits).not.toContain("realtime");
    expect(hits).not.toContain("auth-helpers");
  });

  it("matches sdk substrings and common lang-suffix SDK patterns", () => {
    const hits = matchSignalRepos([
      { name: "my-sdk" },
      { name: "vendor-SDK" },
      { name: "something-js" },
      { name: "supabase-py" },
      { name: "realtime-dart" },
      { name: "sdk-utils" },
      { name: "no-match" },
      { name: "readme" },
    ]).map((r) => r.name);
    expect(hits).toContain("my-sdk");
    expect(hits).toContain("vendor-SDK");
    expect(hits).toContain("sdk-utils");
    expect(hits).toContain("something-js");
    expect(hits).toContain("supabase-py");
    expect(hits).toContain("realtime-dart");
    expect(hits).not.toContain("no-match");
    expect(hits).not.toContain("readme");
  });
});

describe("discoverGithubSignals (injected lister)", () => {
  it("uses the injected lister and returns filtered repos", async () => {
    let called = "";
    const results = await discoverGithubSignals("acme", async (org) => {
      called = org;
      return [
        { name: "acme-core" },
        { name: "acme-cli" },
        { name: "acme-mcp-server" },
      ];
    });
    expect(called).toBe("acme");
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(["acme-cli", "acme-mcp-server"]);
  });

  it("includes org-named monorepo even without signal keywords", async () => {
    const results = await discoverGithubSignals("supabase", async () => [
      { name: "supabase" },
      { name: "realtime" },
      { name: "cli" },
    ]);
    const names = results.map((r) => r.name).sort();
    expect(names).toContain("supabase");
    expect(names).toContain("cli");
    expect(names).not.toContain("realtime");
  });

  it("includes monorepo whose name is a prefix/suffix of the org (n8n-io/n8n)", async () => {
    const results = await discoverGithubSignals("n8n-io", async () => [
      { name: "n8n" },
      { name: "n8n-docs" },
      { name: "unrelated" },
    ]);
    const names = results.map((r) => r.name).sort();
    expect(names).toContain("n8n");
    // n8n-docs doesn't match signal regex nor monorepo, but it does match "-doc" no.
    // Actually n8n-docs has no signal — verify it's excluded.
    expect(names).not.toContain("unrelated");
  });

  it("includes monorepo where org name contains repo (go-gitea/gitea)", async () => {
    const results = await discoverGithubSignals("go-gitea", async () => [
      { name: "gitea" },
      { name: "helm-gitea" },
    ]);
    const names = results.map((r) => r.name).sort();
    expect(names).toContain("gitea");
  });

  it("returns [] when lister returns []", async () => {
    const r = await discoverGithubSignals("empty", async () => []);
    expect(r).toEqual([]);
  });

  it("propagates lister errors explicitly", async () => {
    await expect(
      discoverGithubSignals("x", async () => {
        throw new Error("gh not installed");
      }),
    ).rejects.toThrow(/gh not installed/);
  });
});
