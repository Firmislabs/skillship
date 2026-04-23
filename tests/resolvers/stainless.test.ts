import { describe, expect, test } from "vitest";
import { resolveStainlessSpec } from "../../src/resolvers/stainless.js";

describe("resolveStainlessSpec", () => {
  test("returns null when bytes don't contain openapi_spec_url", async () => {
    const bytes = Buffer.from("configured_endpoints: 10\n", "utf8");
    const out = await resolveStainlessSpec(bytes, async () => Buffer.from(""));
    expect(out).toBeNull();
  });

  test("fetches the referenced URL and returns its bytes", async () => {
    const bytes = Buffer.from(
      [
        "configured_endpoints: 77",
        "openapi_spec_url: https://example.com/spec.yml",
        "openapi_spec_hash: abc",
      ].join("\n"),
      "utf8",
    );
    const fetched: string[] = [];
    const fetchUrl = async (url: string): Promise<Buffer> => {
      fetched.push(url);
      return Buffer.from("openapi: 3.1.0\ninfo:\n  title: t\n", "utf8");
    };
    const out = await resolveStainlessSpec(bytes, fetchUrl);
    expect(fetched).toEqual(["https://example.com/spec.yml"]);
    expect(out).not.toBeNull();
    expect(out?.bytes.toString("utf8")).toContain("openapi: 3.1.0");
    expect(out?.path).toMatch(/openapi\.ya?ml$/);
  });

  test("returns null when fetchUrl rejects", async () => {
    const bytes = Buffer.from(
      "openapi_spec_url: https://example.com/spec.yml\n",
      "utf8",
    );
    const out = await resolveStainlessSpec(bytes, async () => {
      throw new Error("boom");
    });
    expect(out).toBeNull();
  });

  test("handles quoted URL", async () => {
    const bytes = Buffer.from(
      'openapi_spec_url: "https://example.com/spec.yml"\n',
      "utf8",
    );
    const fetched: string[] = [];
    const out = await resolveStainlessSpec(bytes, async (url) => {
      fetched.push(url);
      return Buffer.from("openapi: 3.1.0\n", "utf8");
    });
    expect(fetched).toEqual(["https://example.com/spec.yml"]);
    expect(out).not.toBeNull();
  });
});
