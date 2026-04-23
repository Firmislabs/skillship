import { describe, expect, test } from "vitest";
import {
  fetchGithubRepoBlobs,
  parseGithubRepoUrl,
} from "../../src/resolvers/githubFetcher.js";

type GhInvocation = { readonly args: readonly string[]; readonly stdout: string };

function fakeGhFactory(invocations: GhInvocation[]): (args: readonly string[]) => Promise<string> {
  return async (args) => {
    const hit = invocations.find((i) =>
      JSON.stringify(i.args) === JSON.stringify(args),
    );
    if (hit === undefined) {
      throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
    }
    return hit.stdout;
  };
}

describe("parseGithubRepoUrl", () => {
  test("extracts owner + name from https URL", () => {
    expect(parseGithubRepoUrl("https://github.com/stripe/openapi")).toEqual({
      owner: "stripe",
      name: "openapi",
    });
  });

  test("handles trailing slash + .git", () => {
    expect(
      parseGithubRepoUrl("https://github.com/stripe/stripe-cli.git/"),
    ).toEqual({ owner: "stripe", name: "stripe-cli" });
  });

  test("returns null on non-github URL", () => {
    expect(parseGithubRepoUrl("https://example.com/stripe/cli")).toBeNull();
  });

  test("returns null on malformed URL", () => {
    expect(parseGithubRepoUrl("https://github.com/stripe")).toBeNull();
  });
});

describe("fetchGithubRepoBlobs", () => {
  test("lists tree, filters spec paths, fetches blob bytes", async () => {
    const gh = fakeGhFactory([
      {
        args: [
          "api",
          "repos/acme/api/git/trees/HEAD?recursive=1",
        ],
        stdout: JSON.stringify({
          tree: [
            { path: "README.md", type: "blob", sha: "r1" },
            { path: "openapi.yaml", type: "blob", sha: "o1" },
            { path: ".openref/cli/cli.yaml", type: "blob", sha: "c1" },
            { path: "node_modules/foo.yaml", type: "blob", sha: "x1" },
          ],
        }),
      },
      {
        args: ["api", "repos/acme/api/git/blobs/o1"],
        stdout: JSON.stringify({
          content: Buffer.from("openapi: 3.0.0").toString("base64"),
          encoding: "base64",
        }),
      },
      {
        args: ["api", "repos/acme/api/git/blobs/c1"],
        stdout: JSON.stringify({
          content: Buffer.from("commands: []").toString("base64"),
          encoding: "base64",
        }),
      },
    ]);
    const blobs = await fetchGithubRepoBlobs(
      "https://github.com/acme/api",
      gh,
    );
    expect(blobs.map((b) => b.path).sort()).toEqual([
      ".openref/cli/cli.yaml",
      "openapi.yaml",
    ]);
    const openapi = blobs.find((b) => b.path === "openapi.yaml");
    expect(openapi?.bytes.toString("utf8").trim()).toBe("openapi: 3.0.0");
  });

  test("skips vendored dirs (node_modules, dist, .git)", async () => {
    const gh = fakeGhFactory([
      {
        args: ["api", "repos/a/b/git/trees/HEAD?recursive=1"],
        stdout: JSON.stringify({
          tree: [
            { path: "node_modules/openapi.yaml", type: "blob", sha: "1" },
            { path: "dist/openapi.json", type: "blob", sha: "2" },
            { path: ".git/openapi.yaml", type: "blob", sha: "3" },
            { path: "openapi.yaml", type: "blob", sha: "4" },
          ],
        }),
      },
      {
        args: ["api", "repos/a/b/git/blobs/4"],
        stdout: JSON.stringify({
          content: Buffer.from("x").toString("base64"),
          encoding: "base64",
        }),
      },
    ]);
    const blobs = await fetchGithubRepoBlobs("https://github.com/a/b", gh);
    expect(blobs.map((b) => b.path)).toEqual(["openapi.yaml"]);
  });

  test("non-github URL returns empty", async () => {
    const gh = fakeGhFactory([]);
    const blobs = await fetchGithubRepoBlobs("https://example.com/x/y", gh);
    expect(blobs).toEqual([]);
  });

  test("empty-repo 409 is swallowed (returns [])", async () => {
    const gh = async (args: readonly string[]): Promise<string> => {
      void args;
      throw new Error(
        "gh api repos/acme/empty/git/trees/HEAD?recursive=1 failed: gh: Git Repository is empty. (HTTP 409)",
      );
    };
    const blobs = await fetchGithubRepoBlobs(
      "https://github.com/acme/empty",
      gh,
    );
    expect(blobs).toEqual([]);
  });

  test("moved/private 404 is swallowed (returns [])", async () => {
    const gh = async (args: readonly string[]): Promise<string> => {
      void args;
      throw new Error("gh api failed: gh: Not Found (HTTP 404)");
    };
    const blobs = await fetchGithubRepoBlobs(
      "https://github.com/acme/gone",
      gh,
    );
    expect(blobs).toEqual([]);
  });

  test("bundles external $refs by pulling referenced blobs", async () => {
    const rootYaml = [
      "openapi: 3.0.0",
      "paths:",
      "  /users:",
      "    $ref: './paths/users.yaml'",
    ].join("\n");
    const usersYaml = [
      "get:",
      "  summary: list users",
      "  responses:",
      "    '200':",
      "      description: ok",
    ].join("\n");
    const gh = fakeGhFactory([
      {
        args: ["api", "repos/a/b/git/trees/HEAD?recursive=1"],
        stdout: JSON.stringify({
          tree: [
            { path: "openapi.yaml", type: "blob", sha: "root" },
            { path: "paths/users.yaml", type: "blob", sha: "users" },
          ],
        }),
      },
      {
        args: ["api", "repos/a/b/git/blobs/root"],
        stdout: JSON.stringify({
          content: Buffer.from(rootYaml).toString("base64"),
          encoding: "base64",
        }),
      },
      {
        args: ["api", "repos/a/b/git/blobs/users"],
        stdout: JSON.stringify({
          content: Buffer.from(usersYaml).toString("base64"),
          encoding: "base64",
        }),
      },
    ]);
    const blobs = await fetchGithubRepoBlobs("https://github.com/a/b", gh);
    expect(blobs).toHaveLength(1);
    const bundled = blobs[0]?.bytes.toString("utf8") ?? "";
    expect(bundled).toContain("list users");
    expect(bundled).not.toContain("$ref");
  });

  test("tree truncated: warns via return metadata", async () => {
    const gh = fakeGhFactory([
      {
        args: ["api", "repos/a/b/git/trees/HEAD?recursive=1"],
        stdout: JSON.stringify({ tree: [], truncated: true }),
      },
    ]);
    const blobs = await fetchGithubRepoBlobs("https://github.com/a/b", gh);
    expect(blobs).toEqual([]);
  });
});
