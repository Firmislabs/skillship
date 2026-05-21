import { describe, expect, test } from "vitest";
import { generateRuntimeModule, type AuthSchemeDescriptor } from "../../src/sdk-plugins/runtime.js";

describe("runtime plugin", () => {
  const bearerOnly: readonly AuthSchemeDescriptor[] = [{ kind: "bearer", id: "bearer_main" }];

  test("emits a Client class with declared constructor signature", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toMatch(/export class Client/);
    expect(code).toMatch(/constructor\(opts:\s*ClientOptions\)/);
    expect(code).toMatch(/baseUrl:\s*string/);
    expect(code).toMatch(/auth:\s*AuthConfig/);
    expect(code).toMatch(/defaultHeaders\?\:\s*Record<string,\s*string>/);
    expect(code).toMatch(/fetch\?\:\s*typeof fetch/);
    expect(code).toMatch(/timeout\?\:\s*number/);
  });

  test("AuthConfig is a discriminated union of the projected schemes", () => {
    const code = generateRuntimeModule([
      { kind: "bearer", id: "b1" },
      { kind: "apiKey", id: "k1", in: "header", name: "X-API-Key" },
      { kind: "basic", id: "ba1" },
    ]);
    expect(code).toContain('{ kind: "bearer"; token: string }');
    expect(code).toContain('{ kind: "apiKey"; value: string; in: "header" | "query"; name: string }');
    expect(code).toContain('{ kind: "basic"; username: string; password: string }');
  });

  test("emits onRequest and onResponse interceptor hooks", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toContain("onRequest");
    expect(code).toContain("onResponse");
  });

  test("injects Authorization Bearer header when auth.kind === 'bearer'", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toMatch(/headers\["Authorization"\]\s*=\s*`Bearer\s*\${[^}]+}`/);
  });

  test("injects apiKey into header or query per the 'in' field", () => {
    const code = generateRuntimeModule([{ kind: "apiKey", id: "k1", in: "header", name: "X-API-Key" }]);
    // apiKey-header branch produces a headers[name] = value assignment
    expect(code).toMatch(/headers\[[^\]]+\]\s*=\s*[^;]*value/);
    // apiKey-query branch produces a URLSearchParams append
    expect(code).toMatch(/searchParams\.append\(/);
  });

  test("emitting with empty schemes still produces a working Client (no auth case)", () => {
    const code = generateRuntimeModule([]);
    expect(code).toMatch(/export class Client/);
    // AuthConfig must still type-check (use 'never' or an open union sentinel)
    expect(code).toMatch(/export type AuthConfig/);
  });

  test("emit uses URL 2-arg form with trailing-slash baseUrl normalization (Fix 1)", () => {
    const code = generateRuntimeModule(bearerOnly);
    // baseUrl normalized to trail with "/"
    expect(code).toMatch(/this\.baseUrl\s*=\s*opts\.baseUrl\.replace\(\/\\\/\+\$\/,\s*""\)\s*\+\s*"\/"/);
    // request strips leading slash from input.path
    expect(code).toMatch(/input\.path\.startsWith\("\/"\)/);
    // URL constructed with 2-arg form
    expect(code).toMatch(/new URL\(relPath,\s*this\.baseUrl\)/);
  });

  test("emit enforces timeout via AbortController (Fix 2)", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toContain("AbortController");
    expect(code).toContain("setTimeout");
    expect(code).toContain("clearTimeout");
    expect(code).toMatch(/init\.signal\s*=\s*controller\.signal/);
  });

  test("emit uses btoa (not Buffer) for basic-auth base64 encoding (Fix 3)", () => {
    const code = generateRuntimeModule([{ kind: "basic", id: "ba1" }]);
    expect(code).toContain("btoa(`${this.auth.username}:${this.auth.password}`)");
    expect(code).not.toContain("Buffer.from");
  });

  test("empty schemes emit a satisfiable no-auth AuthConfig (Fix 4)", () => {
    const code = generateRuntimeModule([]);
    expect(code).toContain('export type AuthConfig = { readonly kind: "none" }');
    // Sanity: no impossible `never` intersection sentinel
    expect(code).not.toContain("__skillshipNoAuth");
    expect(code).not.toMatch(/AuthConfig\s*=\s*never/);
  });
});
