import { describe, expect, test } from "vitest";
import { inferSpecContentType } from "../../src/discovery/specSniffer.js";

describe("inferSpecContentType", () => {
  test("detects OpenAPI 3 YAML body", () => {
    const bytes = Buffer.from("openapi: 3.0.3\ninfo:\n  title: x\n", "utf8");
    expect(inferSpecContentType(bytes, "application/yaml")).toBe(
      "application/openapi+yaml",
    );
  });

  test("detects OpenAPI 3 JSON body", () => {
    const bytes = Buffer.from(
      '{"openapi":"3.0.0","info":{"title":"x"}}',
      "utf8",
    );
    expect(inferSpecContentType(bytes, "application/json")).toBe(
      "application/openapi+json",
    );
  });

  test("detects Swagger 2 JSON body", () => {
    const bytes = Buffer.from('{"swagger":"2.0","info":{}}', "utf8");
    expect(inferSpecContentType(bytes, "application/json")).toBe(
      "application/swagger+json",
    );
  });

  test("detects Swagger 2 YAML body", () => {
    const bytes = Buffer.from('swagger: "2.0"\ninfo: {}\n', "utf8");
    expect(inferSpecContentType(bytes, "application/yaml")).toBe(
      "application/swagger+yaml",
    );
  });

  test("normalizes vendor-specific openapi content types (YAML)", () => {
    const bytes = Buffer.from("openapi: 3.1.0\n", "utf8");
    expect(
      inferSpecContentType(bytes, "application/vnd.oai.openapi; charset=utf-8"),
    ).toBe("application/openapi+yaml");
  });

  test("returns declared type when body is not OpenAPI/Swagger", () => {
    const bytes = Buffer.from("<html><body>404</body></html>", "utf8");
    expect(inferSpecContentType(bytes, "text/html")).toBe("text/html");
  });

  test("returns declared type for JSON that isn't OpenAPI", () => {
    const bytes = Buffer.from('{"hello":"world"}', "utf8");
    expect(inferSpecContentType(bytes, "application/json")).toBe(
      "application/json",
    );
  });

  test("handles YAML with leading comment/whitespace", () => {
    const bytes = Buffer.from(
      "# comment\n\nopenapi: 3.0.0\n",
      "utf8",
    );
    expect(inferSpecContentType(bytes, "application/yaml")).toBe(
      "application/openapi+yaml",
    );
  });

  test("handles JSON with leading whitespace", () => {
    const bytes = Buffer.from('\n  {"swagger":"2.0"}', "utf8");
    expect(inferSpecContentType(bytes, "application/json")).toBe(
      "application/swagger+json",
    );
  });
});
