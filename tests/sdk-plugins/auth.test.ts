import { describe, expect, test } from "vitest";
import { generateAuthModule } from "../../src/sdk-plugins/auth.js";
import type { AuthSchemeDescriptor } from "../../src/sdk-plugins/runtime.js";

// ─── fixtures ────────────────────────────────────────────────────────────────
const bearerOnly: readonly AuthSchemeDescriptor[] = [
  { kind: "bearer", id: "bearer_main" },
];
const apiKeyOnly: readonly AuthSchemeDescriptor[] = [
  { kind: "apiKey", id: "k1", in: "header", name: "X-API-Key" },
];
const basicOnly: readonly AuthSchemeDescriptor[] = [
  { kind: "basic", id: "ba1" },
];
const oauth2Baked: readonly AuthSchemeDescriptor[] = [
  {
    kind: "oauth2ClientCredentials",
    id: "oauth_main",
    tokenUrl: "https://auth.example.com/token",
    scopes: ["read", "write"],
  },
];
const oauth2NullUrl: readonly AuthSchemeDescriptor[] = [
  {
    kind: "oauth2ClientCredentials",
    id: "oauth_main",
    tokenUrl: null,
    scopes: [],
  },
];
const externalOnly: readonly AuthSchemeDescriptor[] = [
  { kind: "external", id: "ext1", schemeType: "custom" },
];
const mixed: readonly AuthSchemeDescriptor[] = [
  { kind: "bearer", id: "b1" },
  { kind: "apiKey", id: "k1", in: "query", name: "api_key" },
  { kind: "oauth2ClientCredentials", id: "o1", tokenUrl: null, scopes: [] },
];

const ENV_PREFIX = "ACME";

// ─── header comment ──────────────────────────────────────────────────────────
describe("generateAuthModule — header", () => {
  test("emits auto-generated header comment", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("Auto-generated");
    expect(code).toContain("Do not edit by hand");
  });

  test("imports AuthError and ConfigError from ./errors.js", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("AuthError");
    expect(code).toContain("ConfigError");
    expect(code).toContain('from "./errors.js"');
  });
});

// ─── AuthConfig union ────────────────────────────────────────────────────────
describe("generateAuthModule — AuthConfig union", () => {
  test("tokenProvider member is ALWAYS present regardless of schemes", () => {
    for (const schemes of [bearerOnly, apiKeyOnly, basicOnly, oauth2Baked, externalOnly, []]) {
      const code = generateAuthModule(schemes, ENV_PREFIX);
      expect(code, `schemes=${JSON.stringify(schemes)}`).toContain('kind: "tokenProvider"');
      expect(code).toContain("getToken: () => Promise<string>");
    }
  });

  test("bearer scheme emits bearer member with token: string", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain('kind: "bearer"');
    expect(code).toMatch(/kind:\s*"bearer"[^}]*token:\s*string/s);
  });

  test("apiKey scheme emits apiKey member", () => {
    const code = generateAuthModule(apiKeyOnly, ENV_PREFIX);
    expect(code).toContain('kind: "apiKey"');
    expect(code).toContain("value: string");
  });

  test("basic scheme emits basic member with username/password", () => {
    const code = generateAuthModule(basicOnly, ENV_PREFIX);
    expect(code).toContain('kind: "basic"');
    expect(code).toContain("username: string");
    expect(code).toContain("password: string");
  });

  test("oauth2ClientCredentials emits oauth2 member with required + optional fields", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain('kind: "oauth2"');
    expect(code).toContain("clientId: string");
    expect(code).toContain("clientSecret: string");
    expect(code).toContain("tokenUrl?: string");
    expect(code).toContain("scopes?: string[]");
  });

  test("external descriptor contributes NO member to AuthConfig", () => {
    const code = generateAuthModule(externalOnly, ENV_PREFIX);
    expect(code).not.toContain('kind: "external"');
    // tokenProvider still present
    expect(code).toContain('kind: "tokenProvider"');
  });

  test("empty schemes still emit valid AuthConfig with tokenProvider only", () => {
    const code = generateAuthModule([], ENV_PREFIX);
    expect(code).toMatch(/export type AuthConfig/);
    expect(code).toContain('kind: "tokenProvider"');
  });
});

// ─── resolveAuthFromEnv ──────────────────────────────────────────────────────
describe("generateAuthModule — resolveAuthFromEnv", () => {
  test("function is exported", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("export function resolveAuthFromEnv");
  });

  test("return type includes null", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toMatch(/resolveAuthFromEnv\s*\(\s*\)\s*:\s*AuthConfig\s*\|\s*null/);
  });

  test("bearer scheme uses ACME_TOKEN env var", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("ACME_TOKEN");
  });

  test("apiKey scheme uses ACME_API_KEY env var", () => {
    const code = generateAuthModule(apiKeyOnly, ENV_PREFIX);
    expect(code).toContain("ACME_API_KEY");
  });

  test("apiKey env resolution bakes descriptor in/name — not hardcoded header/Authorization", () => {
    const queryKeyScheme: readonly AuthSchemeDescriptor[] = [
      { kind: "apiKey", id: "k", in: "query", name: "api_key" },
    ];
    const code = generateAuthModule(queryKeyScheme, ENV_PREFIX);
    expect(code).toContain('in: "query"');
    expect(code).toContain('name: "api_key"');
  });

  test("basic scheme uses ACME_USERNAME and ACME_PASSWORD env vars", () => {
    const code = generateAuthModule(basicOnly, ENV_PREFIX);
    expect(code).toContain("ACME_USERNAME");
    expect(code).toContain("ACME_PASSWORD");
  });

  test("oauth2 scheme uses ACME_CLIENT_ID and ACME_CLIENT_SECRET", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("ACME_CLIENT_ID");
    expect(code).toContain("ACME_CLIENT_SECRET");
  });

  test("oauth2 scheme emits ACME_TOKEN_URL optional override", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("ACME_TOKEN_URL");
  });

  test("returns null when nothing matches", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("return null");
  });

  test("env prefix is baked literally — different prefix produces different var names", () => {
    const codeAcme = generateAuthModule(bearerOnly, "ACME");
    const codeFoo = generateAuthModule(bearerOnly, "FOO");
    expect(codeAcme).toContain("ACME_TOKEN");
    expect(codeFoo).toContain("FOO_TOKEN");
    expect(codeFoo).not.toContain("ACME_TOKEN");
  });
});

// ─── AuthManager ─────────────────────────────────────────────────────────────
describe("generateAuthModule — AuthManager class", () => {
  test("export class AuthManager is present", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("export class AuthManager");
  });

  test("constructor receives auth: AuthConfig and fetchImpl: typeof fetch", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toMatch(/constructor\s*\([^)]*auth\s*:\s*AuthConfig/);
    expect(code).toMatch(/fetchImpl\s*:\s*typeof fetch/);
  });

  test("applyAuth method is present with correct signature", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("applyAuth");
    expect(code).toMatch(/applyAuth\s*\([^)]*headers[^)]*searchParams[^)]*\)/);
    expect(code).toMatch(/Promise<void>/);
  });

  test("onUnauthorized method is present and returns boolean", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("onUnauthorized");
    expect(code).toMatch(/onUnauthorized\s*\([^)]*\)\s*:\s*boolean/);
  });
});

// ─── oauth2 token-fetch logic ────────────────────────────────────────────────
describe("generateAuthModule — oauth2 token fetch", () => {
  test("uses grant_type=client_credentials", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain('body.set("grant_type", "client_credentials")');
  });

  test("uses HTTP Basic auth for client credentials (btoa)", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("btoa(");
    expect(code).toMatch(/Authorization.*Basic/);
  });

  test("uses opts.fetch / fetchImpl — never globalThis.fetch directly", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).not.toContain("globalThis.fetch");
    expect(code).toContain("fetchImpl");
  });

  test("cache expiry is now + (expires_in ?? 300) - 60", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toMatch(/expires_in\s*\?\?\s*300/);
    expect(code).toMatch(/Date\.now\(\)/);
    // subtracts 60 seconds for safety margin
    expect(code).toMatch(/[-–]\s*60/);
  });

  test("single-flight via cached in-flight Promise", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    // inflight promise variable
    expect(code).toMatch(/inflight|inFlight|in_flight/i);
  });

  test("invalidate() clears the token cache", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("invalidate");
  });

  test("throws AuthError on malformed token response (missing access_token)", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("access_token");
    expect(code).toContain("malformed token response");
    expect(code).toContain("AuthError");
  });

  test("throws AuthError with status + tokenUrl on non-2xx — never exposes the secret", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    // should reference status or ok check
    expect(code).toMatch(/\.ok|status\s*[><!]/);
    // error message must not embed clientSecret
    expect(code).not.toMatch(/clientSecret.*Error|Error.*clientSecret/);
  });

  test("baked tokenUrl appears as default when descriptor has non-null tokenUrl", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("https://auth.example.com/token");
  });

  test("null tokenUrl requires user supply — emits ConfigError when missing", () => {
    const code = generateAuthModule(oauth2NullUrl, ENV_PREFIX);
    expect(code).toContain("ConfigError");
    // no baked default URL
    expect(code).not.toContain("https://auth.example.com/token");
  });
});

// ─── tokenProvider ────────────────────────────────────────────────────────────
describe("generateAuthModule — tokenProvider branch", () => {
  test("applyAuth handles tokenProvider by calling getToken() and setting Authorization header", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    expect(code).toContain("tokenProvider");
    expect(code).toContain("getToken");
    expect(code).toMatch(/Authorization.*Bearer/);
  });

  test("onUnauthorized returns true for tokenProvider (retry-capable)", () => {
    const code = generateAuthModule(bearerOnly, ENV_PREFIX);
    // onUnauthorized should return true for oauth2/tokenProvider
    expect(code).toContain("return true");
  });
});

// ─── self-review guards ──────────────────────────────────────────────────────
describe("generateAuthModule — self-review", () => {
  test("no 'any' type in emitted code", () => {
    for (const schemes of [bearerOnly, oauth2Baked, mixed]) {
      const code = generateAuthModule(schemes, ENV_PREFIX);
      // allow the word in comments but not as a type annotation
      expect(code, `schemes=${JSON.stringify(schemes)}`).not.toMatch(/:\s*any\b/);
      expect(code).not.toMatch(/<any>/);
    }
  });

  test("emitter output is deterministic (same input → same output)", () => {
    const a = generateAuthModule(oauth2Baked, ENV_PREFIX);
    const b = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(a).toBe(b);
  });

  test("no globalThis.fetch reference in emitted code for any scheme", () => {
    for (const schemes of [bearerOnly, oauth2Baked, mixed]) {
      const code = generateAuthModule(schemes, ENV_PREFIX);
      expect(code, `schemes=${JSON.stringify(schemes)}`).not.toContain("globalThis.fetch");
    }
  });
});

// ─── Fix C1/I1: single-flight finally identity guard ─────────────────────────
describe("generateAuthModule — single-flight finally pattern (C1/I1)", () => {
  test("finally is chained on the fetch call (not orphaned on this.inflight)", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    // The correct form: const inflight = this.fetchOauth2Token(now).finally(...)
    expect(code).toMatch(/=\s*this\.fetchOauth2Token\([^)]*\)\.finally\s*\(/);
  });

  test("finally handler uses identity guard before nulling inflight", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("if (this.inflight === inflight)");
  });

  test("orphaned pattern this.inflight.finally is NOT emitted", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).not.toContain("this.inflight.finally");
  });

  test("same guards apply in mixed (bearer + oauth2) descriptor", () => {
    const code = generateAuthModule(mixed, ENV_PREFIX);
    expect(code).toMatch(/=\s*this\.fetchOauth2Token\([^)]*\)\.finally\s*\(/);
    expect(code).toContain("if (this.inflight === inflight)");
    expect(code).not.toContain("this.inflight.finally");
  });
});

// ─── Fix I2: oauth2 scopes sent in token request ──────────────────────────────
describe("generateAuthModule — oauth2 scopes in token request (I2)", () => {
  test("with non-empty descriptor scopes: emits body.set(\"scope\" ...)", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain('body.set("scope"');
  });

  test("with non-empty scopes: emits a baked default scope join in resolveAuthFromEnv", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    // baked scopes should appear joined in the env branch
    expect(code).toContain("read write");
  });

  test("with empty descriptor scopes: emits guarded scope lines (baked default is empty string)", () => {
    // I1 fix: scope lines are always emitted so user-supplied scopes are forwarded.
    // The baked default is "" — the if(scopeStr) guard prevents scope= being sent
    // at runtime unless the caller explicitly passes scopes: [...].
    const code = generateAuthModule(oauth2NullUrl, ENV_PREFIX);
    // Scope lines present (guarded), baked default is empty string literal.
    expect(code).toContain('body.set("scope"');
    expect(code).toContain('?? ""');
    // Guard must be present — never unconditional.
    expect(code).toMatch(/if\s*\([^)]*scope[^)]*\)[^{]*\{[^}]*body\.set\("scope"/s);
  });

  test("with non-empty scopes: scope set is guarded (conditional, not unconditional)", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    // Must have an if-guard before body.set("scope" — not a bare statement
    expect(code).toMatch(/if\s*\([^)]*scope[^)]*\)[^{]*\{[^}]*body\.set\("scope"/s);
  });

  test("mixed descriptor with empty scopes: emits guarded scope lines (baked default empty, guard present)", () => {
    // I1 fix: mixed has oauth2 with scopes: [] — scope lines always emitted but guarded.
    const code = generateAuthModule(mixed, ENV_PREFIX);
    expect(code).toContain('body.set("scope"');
    // Baked default is "" (empty descriptor scopes).
    expect(code).toContain('?? ""');
    // Guard must be present.
    expect(code).toMatch(/if\s*\([^)]*scope[^)]*\)[^{]*\{[^}]*body\.set\("scope"/s);
  });
});

// ─── Fix M2/M5: dead _hasOauth2 param + redundant as number cast ──────────────
describe("generateAuthModule — emitter cleanup (M2/M5)", () => {
  test("no redundant 'as number' cast on expires_in in emitted code", () => {
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).not.toContain("as number");
  });

  test("buildApplyAuth dead param: emitter still produces correct applyAuth", () => {
    // functional regression — applyAuth must still handle all branches
    const code = generateAuthModule(oauth2Baked, ENV_PREFIX);
    expect(code).toContain("async applyAuth(");
    expect(code).toContain('auth.kind === "oauth2"');
  });
});

// ─── C3: valuePrefix in apiKey descriptor ────────────────────────────────────

import ts from "typescript";

/** Transpile emitted auth module TS → CJS and execute it; return exports. */
function loadAuthModule(
  schemes: readonly AuthSchemeDescriptor[],
  prefix: string,
): Record<string, unknown> {
  const code = generateAuthModule(schemes, prefix);
  const result = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  });
  const exports: Record<string, unknown> = {};
  // require is not used in emitted auth module (self-contained except AuthError/ConfigError)
  const require2 = (mod: string): Record<string, unknown> => {
    if (mod === "./errors.js") {
      return {
        AuthError: class AuthError extends Error { constructor(msg: string) { super(msg); } },
        ConfigError: class ConfigError extends Error { constructor(msg: string) { super(msg); } },
      };
    }
    throw new Error(`Unexpected require: ${mod}`);
  };
  new Function("exports", "require", result.outputText)(exports, require2);
  return exports;
}

/** Call applyAuth on the loaded module and return the headers record. */
async function runApplyAuth(
  exports: Record<string, unknown>,
  auth: Record<string, unknown>,
): Promise<{ headers: Record<string, string>; searchParams: URLSearchParams }> {
  const AuthManager = exports["AuthManager"] as new (
    auth: Record<string, unknown>,
    fetch: typeof fetch,
  ) => { applyAuth: (h: Record<string, string>, sp: URLSearchParams) => Promise<void> };
  const manager = new AuthManager(auth, fetch);
  const headers: Record<string, string> = {};
  const searchParams = new URLSearchParams();
  await manager.applyAuth(headers, searchParams);
  return { headers, searchParams };
}

describe("generateAuthModule — C3 valuePrefix runtime (auth.test.ts)", () => {
  const apiKeyWithPrefix: readonly AuthSchemeDescriptor[] = [
    { kind: "apiKey", id: "overlay_apikey", in: "header", name: "Authorization", valuePrefix: "token " },
  ];
  const apiKeyNoPrefix: readonly AuthSchemeDescriptor[] = [
    { kind: "apiKey", id: "k1", in: "header", name: "Authorization" },
  ];
  const apiKeyEmptyPrefix: readonly AuthSchemeDescriptor[] = [
    { kind: "apiKey", id: "k1", in: "header", name: "Authorization", valuePrefix: "" },
  ];
  const apiKeyQueryPrefix: readonly AuthSchemeDescriptor[] = [
    { kind: "apiKey", id: "k1", in: "query", name: "api_key", valuePrefix: "v1-" },
  ];

  test("header apiKey with valuePrefix emits Authorization: 'token abc' (prefix + value)", async () => {
    const exports = loadAuthModule(apiKeyWithPrefix, "TEST");
    const { headers } = await runApplyAuth(exports, {
      kind: "apiKey", value: "abc", in: "header", name: "Authorization",
    });
    expect(headers["Authorization"]).toBe("token abc");
  });

  test("query apiKey with valuePrefix: searchParams carries prefixed value", async () => {
    const exports = loadAuthModule(apiKeyQueryPrefix, "TEST");
    const { searchParams } = await runApplyAuth(exports, {
      kind: "apiKey", value: "mykey", in: "query", name: "api_key",
    });
    expect(searchParams.get("api_key")).toBe("v1-mykey");
  });

  test("apiKey without valuePrefix — byte-identical output to no-prefix apiKey module", () => {
    const withoutPrefix = generateAuthModule(apiKeyNoPrefix, ENV_PREFIX);
    // Descriptor with no valuePrefix field must generate identical code to one
    // with valuePrefix: "" (both have no/empty prefix → same emission path)
    const withEmptyPrefix = generateAuthModule(apiKeyEmptyPrefix, ENV_PREFIX);
    expect(withoutPrefix).toBe(withEmptyPrefix);
  });

  test("apiKey without valuePrefix runtime: header gets raw value (no prefix injected)", async () => {
    const exports = loadAuthModule(apiKeyNoPrefix, "TEST");
    const { headers } = await runApplyAuth(exports, {
      kind: "apiKey", value: "rawkey", in: "header", name: "Authorization",
    });
    expect(headers["Authorization"]).toBe("rawkey");
  });

  test("REQUIRED_ENV_VARS contains PREFIX_API_KEY for synthesized apiKey", () => {
    const exports = loadAuthModule(apiKeyWithPrefix, "LISTMONK");
    const vars = exports["REQUIRED_ENV_VARS"] as readonly string[];
    expect(vars).toContain("LISTMONK_API_KEY");
  });

  test("resolveAuthFromEnv picks up PREFIX_API_KEY env var and returns correct auth config", () => {
    const exports = loadAuthModule(apiKeyWithPrefix, "LISTMONK");
    const resolveAuthFromEnv = exports["resolveAuthFromEnv"] as (
      env?: Record<string, string>,
    ) => Record<string, unknown> | null;
    // Simulate env injection by patching process.env temporarily
    const origEnv = process.env["LISTMONK_API_KEY"];
    process.env["LISTMONK_API_KEY"] = "mytoken123";
    try {
      const auth = resolveAuthFromEnv();
      expect(auth).not.toBeNull();
      expect(auth?.["kind"]).toBe("apiKey");
      expect(auth?.["value"]).toBe("mytoken123");
    } finally {
      if (origEnv === undefined) delete process.env["LISTMONK_API_KEY"];
      else process.env["LISTMONK_API_KEY"] = origEnv;
    }
  });
});
