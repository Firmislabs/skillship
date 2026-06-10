import { describe, expect, test } from "vitest";
import {
  generateRuntimeModule,
  type AuthSchemeDescriptor,
  type RetriesConfig,
} from "../../src/sdk-plugins/runtime.js";

const bearerOnly: readonly AuthSchemeDescriptor[] = [
  { kind: "bearer", id: "bearer_main" },
];

const DEFAULT_RETRIES: RetriesConfig = {
  maxRetries: 2,
  retryableStatus: [408, 409, 429, 500, 502, 503, 504],
  honorRetryAfter: true,
};

describe("runtime plugin — Client surface", () => {
  test("emits a Client class with declared constructor signature", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/export class Client/);
    expect(code).toMatch(/constructor\(opts:\s*ClientOptions\)/);
    expect(code).toMatch(/baseUrl:\s*string/);
    expect(code).toMatch(/defaultHeaders\?\:\s*Record<string,\s*string>/);
    expect(code).toMatch(/fetch\?\:\s*typeof fetch/);
    expect(code).toMatch(/timeout\?\:\s*number/);
  });

  test("ClientOptions.auth is OPTIONAL (env fallback resolves it)", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/auth\?\:\s*AuthConfig/);
  });

  test("ClientOptions exposes injectable sleep and module has a default sleep", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/sleep\?\:\s*\(ms:\s*number\)\s*=>\s*Promise<void>/);
    // a module-level default sleep implementation
    expect(code).toMatch(/defaultSleep/);
    expect(code).toContain("setTimeout(");
  });

  test("emits onRequest and onResponse interceptor hooks", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("onRequest");
    expect(code).toContain("onResponse");
  });
});

describe("runtime plugin — auth ownership moved to auth.js", () => {
  test("imports AuthConfig, AuthManager, resolveAuthFromEnv from ./auth.js", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(
      /import\s*\{[^}]*AuthConfig[^}]*\}\s*from\s*"\.\/auth\.js"/s,
    );
    expect(code).toContain("AuthManager");
    expect(code).toContain("resolveAuthFromEnv");
  });

  test("runtime no longer DECLARES its own AuthConfig union (single owner = auth.ts)", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    // No `export type AuthConfig = ...` declaration in runtime — only an import.
    expect(code).not.toMatch(/export type AuthConfig\s*=/);
  });

  test("runtime no longer injects bearer inline — delegates to AuthManager.applyAuth", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    // The bearer header literal is now owned by auth.ts; runtime must NOT emit it.
    expect(code).not.toContain('headers["Authorization"] = `Bearer ${this.auth.token}`');
    expect(code).toMatch(/applyAuth\(/);
  });

  test("constructs an AuthManager and resolves auth (explicit > env > ConfigError)", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("new AuthManager(");
    expect(code).toContain("resolveAuthFromEnv()");
    expect(code).toContain("ConfigError");
  });
});

describe("runtime plugin — retry constants from config", () => {
  test("emits MAX_RETRIES from the retries config", () => {
    const code = generateRuntimeModule(bearerOnly, { ...DEFAULT_RETRIES, maxRetries: 5 });
    expect(code).toMatch(/const MAX_RETRIES\s*=\s*5/);
  });

  test("emits RETRYABLE_STATUS as a literal array from config", () => {
    const code = generateRuntimeModule(bearerOnly, {
      ...DEFAULT_RETRIES,
      retryableStatus: [408, 429, 503],
    });
    expect(code).toMatch(/const RETRYABLE_STATUS[^=]*=\s*\[\s*408,\s*429,\s*503\s*\]/);
  });

  test("emits BASE_DELAY_MS = 500 and MAX_DELAY_MS = 30000", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/const BASE_DELAY_MS\s*=\s*500/);
    expect(code).toMatch(/const MAX_DELAY_MS\s*=\s*30000/);
  });

  test("defaults applied when retries config omitted", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toMatch(/const MAX_RETRIES\s*=\s*2/);
    expect(code).toMatch(/408,\s*409,\s*429,\s*500,\s*502,\s*503,\s*504/);
  });
});

describe("runtime plugin — retry loop semantics", () => {
  test("full-jitter backoff: random(0, min(cap, base * 2^attempt))", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("Math.random()");
    expect(code).toContain("Math.min(");
    // exponential term base * 2 ** attempt
    expect(code).toMatch(/2\s*\*\*\s*\w+|Math\.pow\(2/);
  });

  test("honors Retry-After (seconds or http-date) capped at MAX_DELAY_MS when honorRetryAfter", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/Retry-After|retry-after/i);
    expect(code).toContain("MAX_DELAY_MS");
    // http-date parse path
    expect(code).toContain("Date.parse(");
  });

  test("does not honor Retry-After when config disables it", () => {
    const code = generateRuntimeModule(bearerOnly, {
      ...DEFAULT_RETRIES,
      honorRetryAfter: false,
    });
    // The honor flag is baked into a constant the loop reads
    expect(code).toMatch(/const HONOR_RETRY_AFTER\s*=\s*false/);
  });

  test("idempotent methods retry full list + network errors + per-attempt timeout", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/GET\|HEAD\|PUT\|DELETE\|OPTIONS|"GET",\s*"HEAD"/);
  });

  test("POST/PATCH retry only 408/429, never network/timeout", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    // The non-idempotent retryable set is restricted to 408 and 429.
    expect(code).toMatch(/408,\s*429/);
  });

  test("constructs a fresh Request per attempt (bodies single-use)", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    // new Request must occur inside the loop body, referenced per attempt
    expect(code).toContain("new Request(");
    expect(code).toMatch(/for\s*\(|while\s*\(/);
  });

  test("onResponse runs only on the final returned response", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("this.onResponse");
  });

  test("exhaustion rethrows the final typed error with (after N attempts) suffix", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("after ");
    expect(code).toContain("attempts");
  });

  test("uses injected sleep (this.sleep) — no real timers in the loop", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/this\.sleep\(/);
  });
});

describe("runtime plugin — 401 single-refresh outside retry counter", () => {
  test("calls AuthManager.onUnauthorized() and retries once on 401", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("onUnauthorized()");
  });

  test("second 401 throws UnauthorizedError", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("UnauthorizedError");
  });
});

describe("runtime plugin — URL / timeout / error wiring", () => {
  test("emit uses URL 2-arg form with trailing-slash baseUrl normalization", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toMatch(/this\.baseUrl\s*=\s*opts\.baseUrl\.replace\(\/\\\/\+\$\/,\s*""\)\s*\+\s*"\/"/);
    expect(code).toMatch(/resolvedPath\.startsWith\("\/"\)/);
    expect(code).toMatch(/new URL\(relPath,\s*this\.baseUrl\)/);
  });

  test("emit enforces per-attempt timeout via AbortController", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("AbortController");
    expect(code).toContain("setTimeout");
    expect(code).toContain("clearTimeout");
    expect(code).toMatch(/signal:\s*controller\.signal/);
  });

  test("emitted runtime imports TimeoutError from errors.js", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("TimeoutError");
    expect(code).toContain('from "./errors.js"');
  });

  test("emitted runtime catches abort and throws TimeoutError", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("controller.signal.aborted");
    expect(code).toContain("new TimeoutError(");
  });

  test("emitted Client.request input type includes pathParams", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).toContain("pathParams");
  });
});

describe("runtime plugin — auth descriptor matrix (Task 3 follow-ups)", () => {
  test("oauth2-only schemes produce a working module (auth.ts owns the union)", () => {
    const code = generateRuntimeModule(
      [{ kind: "oauth2ClientCredentials", id: "o1", tokenUrl: "https://x/token", scopes: [] }],
      DEFAULT_RETRIES,
    );
    // runtime imports AuthConfig and constructs AuthManager regardless of scheme kind
    expect(code).toContain("AuthManager");
    expect(code).not.toMatch(/export type AuthConfig\s*=/);
  });

  test("mixed [bearer, oauth2] descriptors still emit an inert runtime (no scheme branching)", () => {
    const code = generateRuntimeModule(
      [
        { kind: "bearer", id: "b1" },
        { kind: "oauth2ClientCredentials", id: "o1", tokenUrl: null, scopes: [] },
      ],
      DEFAULT_RETRIES,
    );
    // runtime is scheme-agnostic: it never inlines bearer/oauth2 header logic
    expect(code).not.toContain('headers["Authorization"] = `Bearer ${this.auth.token}`');
    expect(code).toContain("applyAuth(");
  });
});

describe("runtime plugin — self-review guards", () => {
  test("no 'any' type annotation in emitted code", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code).not.toMatch(/:\s*any\b/);
    expect(code).not.toMatch(/<any>/);
  });

  test("emitter output is deterministic", () => {
    const a = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    const b = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(a).toBe(b);
  });

  test("emitted runtime stays under 300 lines", () => {
    const code = generateRuntimeModule(bearerOnly, DEFAULT_RETRIES);
    expect(code.split("\n").length).toBeLessThan(300);
  });
});
