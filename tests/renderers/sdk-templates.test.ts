import { describe, expect, test } from "vitest";
import { renderTemplates, type TemplateContext } from "../../src/renderers/sdk-templates/render.js";

const BEARER_CTX: TemplateContext = {
  productName: "min.example",
  packageName: "@skillship/min-example-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "MIN_EXAMPLE",
  schemes: [{ kind: "bearer", id: "bearerAuth" }],
  plans: new Map(),
};

const GQL_CTX: TemplateContext = {
  productName: "gql.example",
  packageName: "@skillship/gql-example-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "GQL_EXAMPLE",
  schemes: [{ kind: "bearer", id: "bearerAuth" }],
  plans: new Map(),
};

const OAUTH2_CTX: TemplateContext = {
  productName: "agentmin",
  packageName: "@skillship/agentmin-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "AGENTMIN",
  schemes: [
    {
      kind: "oauth2ClientCredentials",
      id: "agentOauth",
      tokenUrl: "https://api.agentmin.test/oauth/token",
      scopes: [],
    },
  ],
  plans: new Map([
    ["listItems", { style: "cursor", requestParam: "cursor", pageSizeParam: "limit", itemsField: "data", nextField: "next_cursor" }],
    ["listLogs", { style: "offset", requestParam: "offset", pageSizeParam: "limit", itemsField: "data", nextField: null }],
  ]),
};

describe("renderTemplates", () => {
  test("emits five files keyed by their final on-disk names", () => {
    const out = renderTemplates(BEARER_CTX);
    expect(Object.keys(out).sort()).toEqual([
      ".npmignore",
      "LICENSE",
      "README.md",
      "package.json",
      "tsconfig.json",
    ]);
  });

  test("package.json is valid JSON with strict ESM exports", () => {
    const out = renderTemplates(BEARER_CTX);
    const pkg = JSON.parse(out["package.json"]!);
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("@skillship/min-example-sdk");
    expect(pkg.license).toBe("MIT");
    expect(pkg.main).toBeDefined();
    expect(pkg.types).toBeDefined();
    expect(pkg.exports).toBeDefined();
  });

  test("tsconfig.json is valid JSON with strict: true", () => {
    const out = renderTemplates(BEARER_CTX);
    const tsc = JSON.parse(out["tsconfig.json"]!);
    expect(tsc.compilerOptions.strict).toBe(true);
    expect(tsc.compilerOptions.module).toMatch(/NodeNext/i);
  });

  test("LICENSE substitutes year and holder", () => {
    const out = renderTemplates(BEARER_CTX);
    expect(out["LICENSE"]).toContain("2026");
    expect(out["LICENSE"]).toContain("Firmis Labs");
  });

  test("README mentions the product name", () => {
    const out = renderTemplates(BEARER_CTX);
    expect(out["README.md"]).toContain("min.example");
  });

  // ── New tests: env-var table ─────────────────────────────────────────────

  test("bearer README contains env-var table row with correct var name", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).toContain("MIN_EXAMPLE_TOKEN");
  });

  test("oauth2 README contains env-var table rows for CLIENT_ID and CLIENT_SECRET", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).toContain("AGENTMIN_CLIENT_ID");
    expect(readme).toContain("AGENTMIN_CLIENT_SECRET");
  });

  test("oauth2 README contains optional AGENTMIN_TOKEN_URL env var", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).toContain("AGENTMIN_TOKEN_URL");
  });

  // ── New tests: oauth2 quickstart section ────────────────────────────────

  test("bearer README does NOT contain oauth2 quickstart section", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).not.toContain("client_credentials");
    expect(readme).not.toContain("clientId");
  });

  test("oauth2 README contains oauth2 quickstart snippet with kind: oauth2", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).toContain('kind: "oauth2"');
    expect(readme).toContain("clientId");
    expect(readme).toContain("clientSecret");
  });

  // ── New tests: tokenProvider section ─────────────────────────────────────

  test("bearer README contains tokenProvider escape-hatch section", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).toContain("tokenProvider");
    expect(readme).toContain("getToken");
  });

  test("oauth2 README also contains tokenProvider escape-hatch section", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).toContain("tokenProvider");
    expect(readme).toContain("getToken");
  });

  // ── New tests: pagination section ────────────────────────────────────────

  test("bearer README (no pagination) does NOT contain Pages() example", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).not.toContain("Pages()");
  });

  test("oauth2+pagination README contains Pages() example", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).toContain("Pages()");
  });

  // ── New tests: retries section ───────────────────────────────────────────

  test("README mentions automatic retries", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).toContain("retr");
    expect(readme).toContain("Retry-After");
  });

  test("README retries section lists the truthful status-code set (409 included, 501 excluded)", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    // 409 must appear — either individually or collapsed into the 408–409 range.
    // The formatter collapses consecutive codes: 408+409 → "408–409", 502+503+504 → "502–504".
    // Exact expected output derived from DEFAULT_RETRIES.retryableStatus = [408,409,429,500,502,503,504].
    expect(readme).toContain("408–409, 429, 500, 502–504");
    // Must NOT imply 501 is retryable via the old erroneous "500–504" range
    expect(readme).not.toContain("500–504");
  });

  // ── Cross-check: no oauth2/pagination in bearer-only product ────────────

  test("bearer README has no AGENTMIN prefix (cross-product guard)", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).not.toContain("AGENTMIN_");
  });

  test("oauth2 README has no MIN_EXAMPLE prefix (cross-product guard)", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).not.toContain("MIN_EXAMPLE_");
  });
});
