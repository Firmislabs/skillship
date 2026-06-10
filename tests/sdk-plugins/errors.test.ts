import { describe, expect, test } from "vitest";
import { generateErrorsModule } from "../../src/sdk-plugins/errors.js";

describe("errors plugin", () => {
  test("generated module declares exactly the 7 classes", () => {
    const code = generateErrorsModule();
    const expected = [
      "export class APIError",
      "export class BadRequestError extends APIError",
      "export class UnauthorizedError extends APIError",
      "export class ForbiddenError extends APIError",
      "export class NotFoundError extends APIError",
      "export class RateLimitError extends APIError",
      "export class InternalServerError extends APIError",
    ];
    for (const decl of expected) {
      expect(code).toContain(decl);
    }
  });

  test("APIError exposes status, requestId, body, code props", () => {
    const code = generateErrorsModule();
    expect(code).toMatch(/readonly status:\s*number/);
    expect(code).toMatch(/readonly requestId:\s*string \| null/);
    expect(code).toMatch(/readonly body:\s*unknown/);
    expect(code).toMatch(/readonly code:\s*string \| null/);
  });

  // I3: TimeoutError subclass
  test("generated module declares TimeoutError as an 8th subclass of APIError", () => {
    const code = generateErrorsModule();
    expect(code).toContain("export class TimeoutError extends APIError");
  });

  test("generated module has accurate header comment (emits hierarchy, no transport patch)", () => {
    const code = generateErrorsModule();
    // Must NOT claim to patch transport
    expect(code).not.toContain("patches");
  });

  // Task 8: auth.ts forward-imports AuthError + ConfigError — these must be real.
  test("generated module declares AuthError extending APIError", () => {
    const code = generateErrorsModule();
    expect(code).toContain("export class AuthError extends APIError");
  });

  test("generated module declares ConfigError extending APIError", () => {
    const code = generateErrorsModule();
    expect(code).toContain("export class ConfigError extends APIError");
  });

  test("AuthError and ConfigError accept a plain message (auth.ts calls new AuthError(\"...\"))", () => {
    const code = generateErrorsModule();
    // auth.ts emits e.g. `new AuthError("malformed token response")` and
    // `new ConfigError("tokenUrl is required ...")` — single string arg form.
    expect(code).toMatch(/class AuthError extends APIError\s*\{[^}]*constructor\(message:\s*string\)/s);
    expect(code).toMatch(/class ConfigError extends APIError\s*\{[^}]*constructor\(message:\s*string\)/s);
  });

  test("UnauthorizedError is reused for 401 (no AuthenticationError invented)", () => {
    const code = generateErrorsModule();
    expect(code).toContain("UnauthorizedError");
    expect(code).not.toContain("AuthenticationError");
  });
});
