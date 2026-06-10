// tests/renderers/fern-oauth-plan.test.ts
// Direct unit tests for computeFernOAuthPlan (exported from sdk-fern.ts).
// No Docker, no file I/O — purely functional.
//
// Coverage:
//  1. Full positive path: descriptor + OAS → non-null plan with exact shape.
//  2. Plan fed into buildFernProject(["rust"]) → generators.yml parses to
//     exact auth-schemes spike block.
//  3. Gate failures: one test per null-return condition.
//  4. expires_in absent from 200 response: implementation includes ONLY
//     properties present in the schema — no dangling ref.

import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { computeFernOAuthPlan } from "../../src/renderers/sdk-fern.js";
import { buildFernProject } from "../../src/renderers/fern-project.js";
import type { AuthSchemeDescriptor } from "../../src/sdk-plugins/runtime.js";

// ---- Fixture builders ----

/** Returns a minimal oauth2ClientCredentials descriptor. */
function makeOAuthDescriptor(tokenUrl: string | null = "https://x.test/oauth/token"): AuthSchemeDescriptor {
  return {
    kind: "oauth2ClientCredentials",
    id: "OAuth2",
    tokenUrl,
    scopes: [],
  };
}

/** Returns an OAS JSON string with a POST /oauth/token carrying client_id/client_secret + access_token/expires_in. */
function makeOasJson(opts: {
  includePath?: boolean;
  includePost?: boolean;
  includeRequestBody?: boolean;
  requestBodyProps?: Record<string, unknown>;
  includeAccessToken?: boolean;
  includeExpiresIn?: boolean;
} = {}): string {
  const {
    includePath = true,
    includePost = true,
    includeRequestBody = true,
    requestBodyProps = { client_id: { type: "string" }, client_secret: { type: "string" } },
    includeAccessToken = true,
    includeExpiresIn = true,
  } = opts;

  const responseProperties: Record<string, unknown> = {};
  if (includeAccessToken) responseProperties["access_token"] = { type: "string" };
  if (includeExpiresIn) responseProperties["expires_in"] = { type: "integer" };

  const postOp = {
    ...(includeRequestBody
      ? {
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: requestBodyProps,
                },
              },
            },
          },
        }
      : {}),
    responses: {
      "200": {
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: responseProperties,
            },
          },
        },
      },
    },
  };

  const paths: Record<string, unknown> = {};
  if (includePath) {
    paths["/oauth/token"] = includePost ? { post: postOp } : { get: postOp };
  }

  return JSON.stringify({ openapi: "3.1.0", paths });
}

// ---- 1. Full positive path ----

describe("computeFernOAuthPlan — positive path", () => {
  test("returns non-null plan with correct tokenEndpoint, requestProps, responseProps", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson();

    const plan = computeFernOAuthPlan(schemes, oasJson);

    expect(plan).not.toBeNull();
    expect(plan!.tokenEndpoint).toBe("POST /oauth/token");
    expect(plan!.requestProps).toEqual({
      "client-id": "$request.client_id",
      "client-secret": "$request.client_secret",
    });
    expect(plan!.responseProps).toEqual({
      "access-token": "$response.access_token",
      "expires-in": "$response.expires_in",
    });
  });

  test("plan fed into buildFernProject(['rust']) → exact auth-schemes spike block in generators.yml", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson();
    const plan = computeFernOAuthPlan(schemes, oasJson)!;

    const { files } = buildFernProject(["rust"], { oauth: plan });
    const gen = parseYaml(files["fern/generators.yml"]);

    // api.auth must be set
    expect(gen.api.auth).toBe("OAuth");
    expect(gen.api.specs).toEqual([{ openapi: "openapi/openapi.json" }]);

    // auth-schemes top-level key
    expect(gen["auth-schemes"]).toBeDefined();
    const scheme = gen["auth-schemes"]["OAuth"];
    expect(scheme.scheme).toBe("oauth");
    expect(scheme.type).toBe("client-credentials");

    const getToken = scheme["get-token"];
    expect(getToken.endpoint).toBe("POST /oauth/token");
    expect(getToken["request-properties"]).toEqual({
      "client-id": "$request.client_id",
      "client-secret": "$request.client_secret",
    });
    expect(getToken["response-properties"]).toEqual({
      "access-token": "$response.access_token",
      "expires-in": "$response.expires_in",
    });

    // generators block is unaffected
    expect(gen.groups.sdks.generators).toHaveLength(1);
    expect(gen.groups.sdks.generators[0].name).toBe("fernapi/fern-rust-sdk");
  });
});

// ---- 2. expires_in absent — no dangling ref ----

describe("computeFernOAuthPlan — expires_in absent", () => {
  test("plan is non-null and responseProps contains only access-token (no dangling expires-in ref)", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson({ includeExpiresIn: false });

    const plan = computeFernOAuthPlan(schemes, oasJson);

    expect(plan).not.toBeNull();
    // Only access-token must be present; no expires-in key at all.
    expect(plan!.responseProps).toEqual({
      "access-token": "$response.access_token",
    });
    expect("expires-in" in plan!.responseProps).toBe(false);
  });
});

// ---- 3. Gate failures ----

describe("computeFernOAuthPlan — gate failures → null", () => {
  test("no oauth2ClientCredentials descriptor → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [
      { kind: "bearer", id: "Bearer" },
    ];
    expect(computeFernOAuthPlan(schemes, makeOasJson())).toBeNull();
  });

  test("empty schemes array → null", () => {
    expect(computeFernOAuthPlan([], makeOasJson())).toBeNull();
  });

  test("tokenUrl is null → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor(null)];
    expect(computeFernOAuthPlan(schemes, makeOasJson())).toBeNull();
  });

  test("path not in OAS paths → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson({ includePath: false });
    expect(computeFernOAuthPlan(schemes, oasJson)).toBeNull();
  });

  test("path present but no POST operation → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson({ includePost: false });
    expect(computeFernOAuthPlan(schemes, oasJson)).toBeNull();
  });

  test("POST present but requestBody has no named properties (empty object) → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson({ requestBodyProps: {} });
    expect(computeFernOAuthPlan(schemes, oasJson)).toBeNull();
  });

  test("POST present but requestBody entirely absent → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson({ includeRequestBody: false });
    expect(computeFernOAuthPlan(schemes, oasJson)).toBeNull();
  });

  test("no access_token in 200 response schema → null", () => {
    const schemes: readonly AuthSchemeDescriptor[] = [makeOAuthDescriptor()];
    const oasJson = makeOasJson({ includeAccessToken: false, includeExpiresIn: true });
    expect(computeFernOAuthPlan(schemes, oasJson)).toBeNull();
  });
});
