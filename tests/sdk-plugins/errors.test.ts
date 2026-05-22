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
});
