import { describe, expect, test } from "vitest";
import { renderTemplates, applySubs, type TemplateContext } from "../../src/renderers/sdk-templates/render.js";

const BEARER_CTX: TemplateContext = {
  productName: "min.example",
  packageName: "@skillship/min-example-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "MIN_EXAMPLE",
  schemes: [{ kind: "bearer", id: "bearerAuth" }],
  plans: new Map(),
  retries: { maxRetries: 2, retryableStatus: [408, 409, 429, 500, 502, 503, 504], honorRetryAfter: true },
  pagesExample: null,
  firstRequestExample: { accessor: "projects.list" },
  mcp: false,
};

const GQL_CTX: TemplateContext = {
  productName: "gql.example",
  packageName: "@skillship/gql-example-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "GQL_EXAMPLE",
  schemes: [{ kind: "bearer", id: "bearerAuth" }],
  plans: new Map(),
  retries: { maxRetries: 2, retryableStatus: [408, 409, 429, 500, 502, 503, 504], honorRetryAfter: true },
  pagesExample: null,
  firstRequestExample: { accessor: "mutation.createProject" },
  mcp: false,
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
  retries: { maxRetries: 2, retryableStatus: [408, 409, 429, 500, 502, 503, 504], honorRetryAfter: true },
  pagesExample: { accessor: "items.list", pageSizeParam: "limit" },
  firstRequestExample: { accessor: "items.create" },
  mcp: false,
};

/** Context with custom retries — exercises Fix A per-product threading. */
const CUSTOM_RETRIES_CTX: TemplateContext = {
  productName: "custom.api",
  packageName: "@skillship/custom-api-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "CUSTOM_API",
  schemes: [{ kind: "bearer", id: "bearerAuth" }],
  plans: new Map(),
  retries: { maxRetries: 5, retryableStatus: [429, 503], honorRetryAfter: true },
  pagesExample: null,
  firstRequestExample: null,
  mcp: false,
};

/** Context with a differently-named pages accessor — exercises Fix B derivation. */
const FETCH_ALL_PAGES_CTX: TemplateContext = {
  productName: "exotic.api",
  packageName: "@skillship/exotic-api-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "EXOTIC_API",
  schemes: [{ kind: "bearer", id: "bearerAuth" }],
  plans: new Map([
    ["fetchAllItems", { style: "cursor", requestParam: "cursor", pageSizeParam: null, itemsField: "data", nextField: "next_cursor" }],
  ]),
  retries: { maxRetries: 2, retryableStatus: [408, 409, 429, 500, 502, 503, 504], honorRetryAfter: true },
  // fetchAllItems → accessor "reports.fetchAll" — tests non-default accessor name
  pagesExample: { accessor: "reports.fetchAll", pageSizeParam: null },
  firstRequestExample: null,
  mcp: false,
};

/** Context with apiKey scheme — exercises Fix C apiKey quickstart branch. */
const APIKEY_CTX: TemplateContext = {
  productName: "apikey.product",
  packageName: "@skillship/apikey-product-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "APIKEY_PRODUCT",
  schemes: [{ kind: "apiKey", id: "apiKeyAuth", in: "header", name: "X-Api-Key" }],
  plans: new Map(),
  retries: { maxRetries: 2, retryableStatus: [408, 409, 429, 500, 502, 503, 504], honorRetryAfter: true },
  pagesExample: null,
  firstRequestExample: null,
  mcp: false,
};

/** Context with basic scheme — exercises Fix C basic quickstart branch. */
const BASIC_CTX: TemplateContext = {
  productName: "basic.product",
  packageName: "@skillship/basic-product-sdk",
  year: 2026,
  licenseHolder: "Firmis Labs",
  envPrefix: "BASIC_PRODUCT",
  schemes: [{ kind: "basic", id: "basicAuth" }],
  plans: new Map(),
  retries: { maxRetries: 2, retryableStatus: [408, 409, 429, 500, 502, 503, 504], honorRetryAfter: true },
  pagesExample: null,
  firstRequestExample: null,
  mcp: false,
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

  // ── Fix A: per-product retries threading ────────────────────────────────

  test("Fix A: custom retries config emits 'up to 5 retries' in README", () => {
    const readme = renderTemplates(CUSTOM_RETRIES_CTX)["README.md"]!;
    expect(readme).toContain("up to 5 retries");
  });

  test("Fix A: custom retries config emits 429, 503 status codes in README", () => {
    const readme = renderTemplates(CUSTOM_RETRIES_CTX)["README.md"]!;
    expect(readme).toContain("429, 503");
  });

  test("Fix A: bearer ctx (DEFAULT) still says 'up to 2 retries'", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).toContain("up to 2 retries");
  });

  test("Fix A: formatStatusCodes — single element emits bare code (no range dash)", () => {
    const readme = renderTemplates({
      ...BEARER_CTX,
      retries: { maxRetries: 1, retryableStatus: [429], honorRetryAfter: true },
    })["README.md"]!;
    expect(readme).toContain("429");
    expect(readme).not.toMatch(/429–/);
  });

  test("Fix A: formatStatusCodes — all-consecutive emits single range", () => {
    const readme = renderTemplates({
      ...BEARER_CTX,
      retries: { maxRetries: 1, retryableStatus: [500, 501, 502], honorRetryAfter: true },
    })["README.md"]!;
    expect(readme).toContain("500–502");
  });

  test("Fix A: formatStatusCodes — empty retryableStatus omits status-codes sentence", () => {
    const readme = renderTemplates({
      ...BEARER_CTX,
      retries: { maxRetries: 1, retryableStatus: [], honorRetryAfter: true },
    })["README.md"]!;
    // Should NOT emit "status codes ()." or "status codes ." — the sentence must be omitted cleanly
    expect(readme).not.toMatch(/status codes\s*\(\)/);
    expect(readme).not.toMatch(/retryable status codes \./);
    expect(readme).not.toMatch(/status codes \(\)/);
  });

  test("Fix A: formatStatusCodes — unsorted input sorts before formatting", () => {
    const readme = renderTemplates({
      ...BEARER_CTX,
      retries: { maxRetries: 2, retryableStatus: [504, 502, 503], honorRetryAfter: true },
    })["README.md"]!;
    expect(readme).toContain("502–504");
  });

  // ── Fix B: derived pagination accessor ──────────────────────────────────

  test("Fix B: pagination example uses pagesExample.accessor (not hardcoded items.list)", () => {
    const readme = renderTemplates(FETCH_ALL_PAGES_CTX)["README.md"]!;
    // Should reference the real accessor name, NOT the old hardcoded "items.listPages"
    expect(readme).toContain("client.reports.fetchAllPages()");
    expect(readme).not.toContain("client.items.listPages()");
  });

  test("Fix B: pagination example includes pageSizeParam hint when non-null", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    // OAUTH2_CTX pagesExample has pageSizeParam: "limit"
    expect(readme).toContain("limit");
  });

  test("Fix B: pagination example omits pageSizeParam hint when null", () => {
    const readme = renderTemplates(FETCH_ALL_PAGES_CTX)["README.md"]!;
    // FETCH_ALL_PAGES_CTX has pageSizeParam: null — no hint line should appear
    expect(readme).not.toMatch(/Pass.*limit.*to control page size/);
  });

  test("Fix B: oauth2+pagination accessor references real resource name (items.list)", () => {
    const readme = renderTemplates(OAUTH2_CTX)["README.md"]!;
    expect(readme).toContain("client.items.listPages()");
  });

  // ── Fix C: env auto-pickup + missing quickstarts + first request ─────────

  test("Fix C: README contains env auto-pickup sentence mentioning no auth option", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    // Should explain that env vars make explicit auth optional
    expect(readme).toContain("no auth option");
  });

  test("Fix C: README contains zero-arg construction idiom (new Client({ baseUrl", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).toContain("new Client({");
    expect(readme).toContain("baseUrl");
  });

  test("Fix C: apiKey README contains apiKey quickstart snippet", () => {
    const readme = renderTemplates(APIKEY_CTX)["README.md"]!;
    expect(readme).toContain('kind: "apiKey"');
    expect(readme).toContain("APIKEY_PRODUCT_API_KEY");
  });

  test("Fix C: basic README contains basic quickstart snippet", () => {
    const readme = renderTemplates(BASIC_CTX)["README.md"]!;
    expect(readme).toContain('kind: "basic"');
    expect(readme).toContain("BASIC_PRODUCT_USERNAME");
    expect(readme).toContain("BASIC_PRODUCT_PASSWORD");
  });

  test("Fix C: bearer README does NOT contain apiKey or basic snippets", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    expect(readme).not.toContain('kind: "apiKey"');
    expect(readme).not.toContain('kind: "basic"');
  });

  test("Fix C: README contains a Make a request section or equivalent example", () => {
    const readme = renderTemplates(BEARER_CTX)["README.md"]!;
    // Should have a first-request/usage example section
    expect(readme).toContain("request");
  });

  // ── First-request example ────────────────────────────────────────────────

  test("first-request: README with firstRequestExample emits Make a request section", () => {
    const ctx: TemplateContext = {
      ...BEARER_CTX,
      firstRequestExample: { accessor: "projects.list" },
    };
    const readme = renderTemplates(ctx)["README.md"]!;
    expect(readme).toContain("## Make a request");
    expect(readme).toContain("client.projects.list()");
  });

  test("first-request: README with firstRequestExample null omits section", () => {
    const ctx: TemplateContext = {
      ...BEARER_CTX,
      firstRequestExample: null,
    };
    const readme = renderTemplates(ctx)["README.md"]!;
    expect(readme).not.toContain("## Make a request");
  });

  test("first-request: accessor is rendered verbatim (non-list method)", () => {
    const ctx: TemplateContext = {
      ...BEARER_CTX,
      firstRequestExample: { accessor: "emails.send" },
    };
    const readme = renderTemplates(ctx)["README.md"]!;
    expect(readme).toContain("client.emails.send()");
  });

  test("Fix C: env table is emitted without dangling lead-in when table is empty", () => {
    const noAuthCtx: TemplateContext = {
      ...BEARER_CTX,
      schemes: [],
    };
    const readme = renderTemplates(noAuthCtx)["README.md"]!;
    // When table is empty, the "Set the following environment variables" lead-in
    // must NOT appear dangling without a table beneath it
    expect(readme).not.toContain("Set the following environment variables");
  });

  // ── T6: conditional MCP bin entry in package.json ────────────────────────

  test("mcp:true adds a bin entry keyed by <slug>-mcp → bin/mcp.js", () => {
    const out = renderTemplates({ ...BEARER_CTX, mcp: true });
    const pkg = JSON.parse(out["package.json"]!);
    expect(pkg.bin).toEqual({ "min-example-mcp": "bin/mcp.js" });
  });

  test("mcp:false (default) omits the bin key entirely", () => {
    const out = renderTemplates({ ...BEARER_CTX, mcp: false });
    const pkg = JSON.parse(out["package.json"]!);
    expect(pkg.bin).toBeUndefined();
  });

  test("mcp:false package.json stays byte-identical to no-bin baseline shape", () => {
    const out = renderTemplates({ ...BEARER_CTX, mcp: false });
    // Valid JSON and no stray "bin" token anywhere.
    expect(() => JSON.parse(out["package.json"]!)).not.toThrow();
    expect(out["package.json"]).not.toContain('"bin"');
  });

  test("mcp:true bin slug derives from product name (oauth2 ctx)", () => {
    const out = renderTemplates({ ...OAUTH2_CTX, mcp: true });
    const pkg = JSON.parse(out["package.json"]!);
    expect(pkg.bin).toEqual({ "agentmin-mcp": "bin/mcp.js" });
  });

  // ── T6: conditional "Use with Claude Code" README section ────────────────

  test("mcp:true README contains a Use with Claude Code section", () => {
    const readme = renderTemplates({ ...BEARER_CTX, mcp: true })["README.md"]!;
    expect(readme).toContain("## Use with Claude Code");
  });

  test("mcp:true README snippet uses node + sdk/bin/mcp.js relative command", () => {
    const readme = renderTemplates({ ...BEARER_CTX, mcp: true })["README.md"]!;
    expect(readme).toContain('"command": "node"');
    expect(readme).toContain('"args": ["sdk/bin/mcp.js"]');
  });

  test("mcp:true README points to env table and notes Node >=23.6", () => {
    const readme = renderTemplates({ ...BEARER_CTX, mcp: true })["README.md"]!;
    expect(readme).toContain("Authentication");
    expect(readme).toContain("23.6");
  });

  test("mcp:true README says three gateway tools (not tool-per-operation)", () => {
    const readme = renderTemplates({ ...BEARER_CTX, mcp: true })["README.md"]!;
    expect(readme).toContain("three tools");
    expect(readme).toContain("search_operations");
    expect(readme).toContain("describe_operation");
    expect(readme).toContain("invoke_operation");
    expect(readme).not.toContain("exposing every operation as a tool");
  });

  test("mcp:true README references the shipped .mcp.json at skill root (not sdk/ copy advice)", () => {
    const readme = renderTemplates({ ...BEARER_CTX, mcp: true })["README.md"]!;
    expect(readme).toContain("ships at the skill root");
    expect(readme).not.toContain(".mcp.json` next to your `sdk/` directory");
  });

  test("mcp:false README omits the Use with Claude Code section", () => {
    const readme = renderTemplates({ ...BEARER_CTX, mcp: false })["README.md"]!;
    expect(readme).not.toContain("## Use with Claude Code");
    expect(readme).not.toContain("sdk/bin/mcp.js");
  });

  // ── Fix 3: structural JSON.parse guard on rendered package.json ───────────

  test("structural guard: mcp:false package.json is valid JSON (guard passes)", () => {
    const out = renderTemplates({ ...BEARER_CTX, mcp: false });
    expect(() => JSON.parse(out["package.json"]!)).not.toThrow();
  });

  test("structural guard: mcp:true package.json is valid JSON (guard passes)", () => {
    const out = renderTemplates({ ...BEARER_CTX, mcp: true });
    expect(() => JSON.parse(out["package.json"]!)).not.toThrow();
  });

  test("structural guard: applySubs with a broken bin fragment produces invalid JSON", () => {
    // Demonstrates what the guard catches: a malformed PACKAGE_BIN that breaks JSON syntax.
    const brokenTemplate = `{\n  "name": "test"{{PACKAGE_BIN}}\n}`;
    const rendered = applySubs(brokenTemplate, { PACKAGE_BIN: ',\n  "bin": {MISSING_QUOTE: "bin/mcp.js"}' });
    expect(() => JSON.parse(rendered)).toThrow();
  });
});
