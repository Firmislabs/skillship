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
    expect(code).toMatch(/"Authorization":\s*`Bearer\s*\${[^}]+}`/);
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
});
