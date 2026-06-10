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
