// tests/renderers/sdk-utils.test.ts
// Unit tests for extractAuthSchemes mapping table.
// Covers all scheme types including oauth2/external that previously threw.

import { describe, expect, test } from "vitest";
import { extractAuthSchemes } from "../../src/renderers/sdk-utils.js";

// ---- helpers ----

function makeOas(
  securitySchemes: Record<string, unknown>,
): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {},
    components: { schemas: {}, securitySchemes },
  });
}

// ---- existing scheme types (must not regress) ----

describe("extractAuthSchemes — existing kinds", () => {
  test("http+bearer maps to { kind: 'bearer', id }", () => {
    const result = extractAuthSchemes(
      makeOas({ myBearer: { type: "http", scheme: "bearer" } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "bearer", id: "myBearer" });
  });

  test("http+basic maps to { kind: 'basic', id }", () => {
    const result = extractAuthSchemes(
      makeOas({ basicAuth: { type: "http", scheme: "basic" } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "basic", id: "basicAuth" });
  });

  test("apiKey in header maps correctly", () => {
    const result = extractAuthSchemes(
      makeOas({ myKey: { type: "apiKey", in: "header", name: "X-Api-Key" } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "apiKey",
      id: "myKey",
      in: "header",
      name: "X-Api-Key",
    });
  });

  test("apiKey in query maps correctly", () => {
    const result = extractAuthSchemes(
      makeOas({ qKey: { type: "apiKey", in: "query", name: "api_key" } }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "apiKey",
      id: "qKey",
      in: "query",
      name: "api_key",
    });
  });

  test("empty securitySchemes returns empty array", () => {
    const result = extractAuthSchemes(makeOas({}));
    expect(result).toHaveLength(0);
  });
});

// ---- new kinds: oauth2 ----

describe("extractAuthSchemes — oauth2", () => {
  test("oauth2 + clientCredentials flow maps to oauth2ClientCredentials with tokenUrl and scopes", () => {
    const result = extractAuthSchemes(
      makeOas({
        myOauth: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "https://example.com/token",
              scopes: { "read:data": "Read data", "write:data": "Write data" },
            },
          },
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myOauth",
      tokenUrl: "https://example.com/token",
      scopes: expect.arrayContaining(["read:data", "write:data"]),
    });
    // scopes length should match
    const desc = result[0] as { kind: "oauth2ClientCredentials"; scopes: readonly string[] };
    expect(desc.scopes).toHaveLength(2);
  });

  test("oauth2 + clientCredentials with empty scopes maps correctly", () => {
    const result = extractAuthSchemes(
      makeOas({
        myOauth: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "https://example.com/token",
              scopes: {},
            },
          },
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myOauth",
      tokenUrl: "https://example.com/token",
      scopes: [],
    });
  });

  test("oauth2 with other flows (no clientCredentials) maps to oauth2ClientCredentials with tokenUrl null and empty scopes", () => {
    const result = extractAuthSchemes(
      makeOas({
        myOauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://example.com/auth",
              tokenUrl: "https://example.com/token",
              scopes: {},
            },
          },
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myOauth",
      tokenUrl: null,
      scopes: [],
    });
  });

  test("oauth2 with empty flows maps to oauth2ClientCredentials with tokenUrl null and empty scopes", () => {
    const result = extractAuthSchemes(
      makeOas({
        myOauth: {
          type: "oauth2",
          flows: {},
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myOauth",
      tokenUrl: null,
      scopes: [],
    });
  });

  test("oauth2 with no flows field maps to oauth2ClientCredentials with tokenUrl null and empty scopes", () => {
    const result = extractAuthSchemes(
      makeOas({
        myOauth: {
          type: "oauth2",
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myOauth",
      tokenUrl: null,
      scopes: [],
    });
  });
});

// ---- new kinds: external ----

describe("extractAuthSchemes — external kinds", () => {
  test("openIdConnect maps to { kind: 'external', schemeType: 'openIdConnect' }", () => {
    const result = extractAuthSchemes(
      makeOas({
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl: "https://example.com/.well-known/openid-configuration",
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "external",
      id: "oidc",
      schemeType: "openIdConnect",
    });
  });

  test("mutualTLS maps to { kind: 'external', schemeType: 'mutualTLS' }", () => {
    const result = extractAuthSchemes(
      makeOas({
        mtls: {
          type: "mutualTLS",
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "external",
      id: "mtls",
      schemeType: "mutualTLS",
    });
  });

  test("unknown http scheme maps to { kind: 'external', schemeType: 'http' }", () => {
    const result = extractAuthSchemes(
      makeOas({
        digest: {
          type: "http",
          scheme: "digest",
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "external",
      id: "digest",
      schemeType: "http",
    });
  });

  test("unknown type maps to { kind: 'external', schemeType: '<type>' }", () => {
    const result = extractAuthSchemes(
      makeOas({
        customScheme: {
          type: "customType",
        },
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "external",
      id: "customScheme",
      schemeType: "customType",
    });
  });
});

// ---- C3: overlay synthesis from zero schemes ----

const EMPTY_OAS = makeOas({});

describe("extractAuthSchemes — C3 synthesis from zero schemes", () => {
  test("apiKey mode synthesizes overlay_apikey descriptor with overlay name/in/valuePrefix", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: {
        mode: "apiKey" as const,
        in: "header" as const,
        name: "Authorization",
        valuePrefix: "token ",
      },
    };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "apiKey",
      id: "overlay_apikey",
      in: "header",
      name: "Authorization",
      valuePrefix: "token ",
    });
  });

  test("apiKey synthesis uses X-API-Key default name when overlay.auth.name absent", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "apiKey" as const },
    };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "apiKey",
      id: "overlay_apikey",
      name: "X-API-Key",
    });
  });

  test("apiKey synthesis uses empty string valuePrefix when absent", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "apiKey" as const, in: "header" as const, name: "Authorization" },
    };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(1);
    const desc = result[0] as { kind: "apiKey"; valuePrefix: string };
    expect(desc.valuePrefix).toBe("");
  });

  test("bearer mode synthesizes overlay_bearer descriptor", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "bearer" as const },
    };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "bearer", id: "overlay_bearer" });
  });

  test("oauth2-client-credentials mode synthesizes oauth2ClientCredentials with tokenUrl from overlay", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: {
        mode: "oauth2-client-credentials" as const,
        tokenUrl: "https://auth.example.com/token",
      },
    };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "overlay_oauth2",
      tokenUrl: "https://auth.example.com/token",
      scopes: [],
    });
  });

  test("oauth2-client-credentials synthesis uses null tokenUrl when absent in overlay", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "oauth2-client-credentials" as const },
    };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "oauth2ClientCredentials",
      id: "overlay_oauth2",
      tokenUrl: null,
      scopes: [],
    });
  });

  test("no overlay → zero schemes remains empty (synthesis only fires when overlay.auth is set)", () => {
    const result = extractAuthSchemes(EMPTY_OAS, undefined);
    expect(result).toHaveLength(0);
  });

  test("overlay without auth → zero schemes remains empty", () => {
    const overlay = { resources: {}, streaming: [] };
    const result = extractAuthSchemes(EMPTY_OAS, overlay);
    expect(result).toHaveLength(0);
  });
});

// ---- C3: overlay apiKey override of declared apiKey descriptor ----

describe("extractAuthSchemes — C3 apiKey overlay override of declared descriptor", () => {
  test("overlay apiKey mode overrides declared apiKey descriptor name and in", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: {
        mode: "apiKey" as const,
        in: "header" as const,
        name: "Authorization",
        valuePrefix: "token ",
      },
    };
    const result = extractAuthSchemes(
      makeOas({ myKey: { type: "apiKey", in: "query", name: "api_key" } }),
      overlay,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "apiKey",
      id: "myKey",
      in: "header",
      name: "Authorization",
      valuePrefix: "token ",
    });
  });

  test("overlay apiKey override preserves original id", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "apiKey" as const, in: "header" as const, name: "X-Token" },
    };
    const result = extractAuthSchemes(
      makeOas({ secretKey: { type: "apiKey", in: "header", name: "old-name" } }),
      overlay,
    );
    expect(result[0]).toMatchObject({ id: "secretKey", name: "X-Token" });
  });

  test("non-matching declared kinds left untouched when overlay mode is apiKey but scheme is bearer", () => {
    // Declared bearer + overlay apiKey mode → no apiKey declared → synthesize
    // (The declared bearer is NOT touched — synthesis is an ADD, not a replace)
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "apiKey" as const, in: "header" as const, name: "Authorization" },
    };
    const result = extractAuthSchemes(
      makeOas({ tok: { type: "http", scheme: "bearer" } }),
      overlay,
    );
    // bearer is declared — but overlay is apiKey mode, no apiKey declared → synthesize apiKey
    // The declared bearer is still there; synthesized apiKey is also present
    const kinds = result.map((d) => d.kind);
    expect(kinds).toContain("apiKey");
    expect(kinds).toContain("bearer");
  });

  test("declared bearer with overlay bearer mode: bearer not duplicated", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "bearer" as const },
    };
    const result = extractAuthSchemes(
      makeOas({ tok: { type: "http", scheme: "bearer" } }),
      overlay,
    );
    // bearer is already declared — no synthesis needed
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "bearer", id: "tok" });
  });
});

// ---- overlay interaction ----

describe("extractAuthSchemes — overlay parameter", () => {
  test("overlay parameter is accepted (optional) without changing bearer output", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: { mode: "bearer" as const },
    };
    const result = extractAuthSchemes(
      makeOas({ tok: { type: "http", scheme: "bearer" } }),
      overlay,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "bearer", id: "tok" });
  });

  test("overlay auth.mode=oauth2-client-credentials forces oauth2ClientCredentials descriptor", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: {
        mode: "oauth2-client-credentials" as const,
        tokenUrl: "https://overlay.example.com/token",
      },
    };
    const result = extractAuthSchemes(
      makeOas({ myBearer: { type: "http", scheme: "bearer" } }),
      overlay,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myBearer",
      tokenUrl: "https://overlay.example.com/token",
      scopes: [],
    });
  });

  test("overlay auth.tokenUrl fills null tokenUrl from oauth2 scheme", () => {
    const overlay = {
      resources: {},
      streaming: [],
      auth: {
        mode: "oauth2-client-credentials" as const,
        tokenUrl: "https://override.example.com/token",
      },
    };
    const result = extractAuthSchemes(
      makeOas({
        myOauth: {
          type: "oauth2",
          flows: { authorizationCode: {} },
        },
      }),
      overlay,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      kind: "oauth2ClientCredentials",
      id: "myOauth",
      tokenUrl: "https://override.example.com/token",
      scopes: [],
    });
  });
});
