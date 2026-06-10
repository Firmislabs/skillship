import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFernProject, type FernOAuthPlan } from "../../src/renderers/fern-project.js";

describe("buildFernProject", () => {
  test("emits fern.config.json + generators.yml for requested langs only", () => {
    const { files } = buildFernProject(["python"], { oauth: null });
    expect(files["fern/fern.config.json"]).toContain('"organization": "skillship"');
    // Pin-guard: a silent version bump must fail here (single source of truth = fern-images.ts).
    const config = JSON.parse(files["fern/fern.config.json"]);
    expect(config.version).toBe("5.45.3"); // FERN_PINS.cliVersion
    const gen = parseYaml(files["fern/generators.yml"]);
    // api.specs is required — Fern aborts with "empty API definition" without it (Spike 0.1).
    expect(gen.api.specs).toEqual([{ openapi: "openapi/openapi.json" }]);
    const names = gen.groups.sdks.generators.map((g: { name: string }) => g.name);
    expect(names).toEqual(["fernapi/fern-python-sdk"]);
    expect(gen.groups.sdks.generators[0].output.path).toBe("../out/python");
    expect(gen.groups.sdks.generators[0].version).toBe("5.14.12"); // python tag pin-guard
    // Spike 0.3: package_name sets the docstring import root; deterministic.
    expect(gen.groups.sdks.generators[0].config).toEqual({ package_name: "skillship_sdk" });
  });

  test("rust generator carries no python package config", () => {
    const { files } = buildFernProject(["rust"], { oauth: null });
    const gen = parseYaml(files["fern/generators.yml"]);
    expect(gen.groups.sdks.generators[0].config).toBeUndefined();
  });

  test("throws on empty langs", () => {
    expect(() => buildFernProject([], { oauth: null })).toThrow(/non-empty/);
  });

  test("emits both generators in order with config isolation", () => {
    const { files } = buildFernProject(["python", "rust"], { oauth: null });
    const gen = parseYaml(files["fern/generators.yml"]);
    expect(gen.groups.sdks.generators).toHaveLength(2);
    expect(gen.groups.sdks.generators[0].name).toBe("fernapi/fern-python-sdk");
    expect(gen.groups.sdks.generators[1].name).toBe("fernapi/fern-rust-sdk");
    expect(gen.groups.sdks.generators[1].version).toBe("0.40.4"); // rust tag pin-guard
    // Config isolation: python carries package_name, rust carries none.
    expect(gen.groups.sdks.generators[0].config).toEqual({ package_name: "skillship_sdk" });
    expect(gen.groups.sdks.generators[1].config).toBeUndefined();
  });
});

// ---- OAuth auth-schemes tests ----

const OAUTH_PLAN: FernOAuthPlan = {
  tokenEndpoint: "POST /oauth/token",
  requestProps: { "client-id": "$request.client_id", "client-secret": "$request.client_secret" },
  responseProps: { "access-token": "$response.access_token", "expires-in": "$response.expires_in" },
};

describe("buildFernProject — OAuth auth-schemes", () => {
  test("with null oauth plan: no auth-schemes key and api.auth not set (byte-stable bearer default)", () => {
    const { files } = buildFernProject(["python"], { oauth: null });
    const gen = parseYaml(files["fern/generators.yml"]);
    expect(gen["auth-schemes"]).toBeUndefined();
    expect(gen.api?.auth).toBeUndefined();
    // api.specs must still be present
    expect(gen.api.specs).toEqual([{ openapi: "openapi/openapi.json" }]);
  });

  test("with oauth plan: generates exact S1 auth-schemes block + api.auth: OAuth", () => {
    const { files } = buildFernProject(["python"], { oauth: OAUTH_PLAN });
    const gen = parseYaml(files["fern/generators.yml"]);

    // auth-schemes must be present with OAuth key
    expect(gen["auth-schemes"]).toBeDefined();
    const scheme = gen["auth-schemes"]["OAuth"];
    expect(scheme.scheme).toBe("oauth");
    expect(scheme.type).toBe("client-credentials");
    expect(scheme["get-token"].endpoint).toBe("POST /oauth/token");
    // request-properties must use $request. prefix
    expect(scheme["get-token"]["request-properties"]["client-id"]).toBe("$request.client_id");
    expect(scheme["get-token"]["request-properties"]["client-secret"]).toBe("$request.client_secret");
    // response-properties must use $response. prefix
    expect(scheme["get-token"]["response-properties"]["access-token"]).toBe("$response.access_token");
    expect(scheme["get-token"]["response-properties"]["expires-in"]).toBe("$response.expires_in");

    // api.auth must be set to OAuth
    expect(gen.api.auth).toBe("OAuth");
    // api.specs must still be present
    expect(gen.api.specs).toEqual([{ openapi: "openapi/openapi.json" }]);
  });

  test("oauth plan: generators and config blocks are unaffected", () => {
    const { files } = buildFernProject(["python", "rust"], { oauth: OAUTH_PLAN });
    const gen = parseYaml(files["fern/generators.yml"]);
    expect(gen.groups.sdks.generators).toHaveLength(2);
    expect(gen.groups.sdks.generators[0].config).toEqual({ package_name: "skillship_sdk" });
    expect(gen.groups.sdks.generators[1].config).toBeUndefined();
  });
});
