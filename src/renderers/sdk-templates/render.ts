// src/renderers/sdk-templates/render.ts
// Loads .tpl files from this directory and substitutes {{PLACEHOLDERS}}.
// Determinism: iteration over a fixed file list in fixed order.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthSchemeDescriptor, RetriesConfig } from "../../sdk-plugins/runtime.js";
import type { PaginationPlan } from "../pagination-detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface PagesExample {
  /** Accessor path on the client, e.g. "items.list" → used as "client.items.listPages()". */
  readonly accessor: string;
  /** pageSizeParam from the plan, or null when no size param exists. */
  readonly pageSizeParam: string | null;
}

export interface TemplateContext {
  readonly productName: string;
  readonly packageName: string;
  readonly year: number;
  readonly licenseHolder: string;
  readonly envPrefix: string;
  readonly schemes: readonly AuthSchemeDescriptor[];
  readonly plans: ReadonlyMap<string, PaginationPlan>;
  /** Per-product retries config — drives both max-retries count and status-code list in the README. */
  readonly retries: RetriesConfig;
  /** Derived from the first plan entry; null when the product has no pagination. */
  readonly pagesExample: PagesExample | null;
}

interface TemplateSpec {
  readonly tplFile: string;
  readonly outName: string;
}

const TEMPLATES: readonly TemplateSpec[] = [
  { tplFile: "package.json.tpl", outName: "package.json" },
  { tplFile: "tsconfig.json.tpl", outName: "tsconfig.json" },
  { tplFile: "README.md.tpl", outName: "README.md" },
  { tplFile: "LICENSE.tpl", outName: "LICENSE" },
  { tplFile: "npmignore.tpl", outName: ".npmignore" },
];

export function renderTemplates(
  ctx: TemplateContext,
): Record<string, string> {
  const slug = ctx.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const subs: Record<string, string> = {
    PACKAGE_NAME: ctx.packageName,
    PACKAGE_SLUG: slug,
    PRODUCT_NAME: ctx.productName,
    YEAR: String(ctx.year),
    HOLDER: ctx.licenseHolder,
    README_ENV_TABLE: buildEnvTable(ctx.schemes, ctx.envPrefix),
    README_AUTH_QUICKSTART: buildAuthQuickstart(ctx.schemes, ctx.envPrefix, ctx.packageName),
    README_TOKEN_PROVIDER: buildTokenProviderSection(ctx.packageName),
    README_PAGINATION: buildPaginationSection(ctx.pagesExample, ctx.packageName),
    README_RETRIES: buildRetriesSection(ctx.retries),
  };
  const out: Record<string, string> = {};
  for (const spec of TEMPLATES) {
    const raw = readFileSync(join(HERE, spec.tplFile), "utf8");
    let rendered = applySubs(raw, subs);
    if (spec.outName === "README.md") {
      // Collapse runs of 3+ newlines (from empty optional sections) to 2.
      rendered = rendered.replace(/\n{3,}/g, "\n\n");
    }
    out[spec.outName] = rendered;
  }
  return out;
}

function applySubs(raw: string, subs: Record<string, string>): string {
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const v = subs[key];
    if (v === undefined) throw new Error(`renderTemplates: missing substitution for ${key}`);
    return v;
  });
}

// ── Env-var table ────────────────────────────────────────────────────────────

function buildEnvTable(
  schemes: readonly AuthSchemeDescriptor[],
  envPrefix: string,
): string {
  const rows = envRows(schemes, envPrefix);
  if (rows.length === 0) return "";
  const header = "| Variable | Required | Description |";
  const divider = "|----------|----------|-------------|";
  const table = [header, divider, ...rows].join("\n");
  return [
    "Set the following environment variables before constructing the client:",
    "",
    table,
    "",
    `With these set, \`new Client({ baseUrl: "..." })\` needs no auth option — the client picks them up automatically.`,
    "Passing `auth` explicitly overrides the environment.",
  ].join("\n");
}

function envRows(
  schemes: readonly AuthSchemeDescriptor[],
  envPrefix: string,
): string[] {
  const rows: string[] = [];
  const seen = new Set<string>();
  for (const s of schemes) {
    if (s.kind === "bearer" && !seen.has("bearer")) {
      seen.add("bearer");
      rows.push(`| \`${envPrefix}_TOKEN\` | Yes | Bearer token |`);
    } else if (s.kind === "apiKey" && !seen.has("apiKey")) {
      seen.add("apiKey");
      rows.push(`| \`${envPrefix}_API_KEY\` | Yes | API key |`);
    } else if (s.kind === "basic" && !seen.has("basic")) {
      seen.add("basic");
      rows.push(`| \`${envPrefix}_USERNAME\` | Yes | HTTP Basic username |`);
      rows.push(`| \`${envPrefix}_PASSWORD\` | Yes | HTTP Basic password |`);
    } else if (s.kind === "oauth2ClientCredentials" && !seen.has("oauth2")) {
      seen.add("oauth2");
      rows.push(`| \`${envPrefix}_CLIENT_ID\` | Yes | OAuth2 client ID |`);
      rows.push(`| \`${envPrefix}_CLIENT_SECRET\` | Yes | OAuth2 client secret |`);
      rows.push(`| \`${envPrefix}_TOKEN_URL\` | No | Token endpoint (overrides default) |`);
    }
    // external: no env row
  }
  return rows;
}

// ── Auth quickstart section ───────────────────────────────────────────────────

function buildAuthQuickstart(
  schemes: readonly AuthSchemeDescriptor[],
  envPrefix: string,
  packageName: string,
): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const s of schemes) {
    if (s.kind === "bearer" && !seen.has("bearer")) {
      seen.add("bearer");
      parts.push(buildBearerQuickstart(envPrefix, packageName));
    } else if (s.kind === "apiKey" && !seen.has("apiKey")) {
      seen.add("apiKey");
      parts.push(buildApiKeyQuickstart(envPrefix, packageName));
    } else if (s.kind === "basic" && !seen.has("basic")) {
      seen.add("basic");
      parts.push(buildBasicQuickstart(envPrefix, packageName));
    } else if (s.kind === "oauth2ClientCredentials" && !seen.has("oauth2")) {
      seen.add("oauth2");
      parts.push(buildOauth2Quickstart(envPrefix, packageName));
    }
  }
  return parts.join("\n\n");
}

function buildBearerQuickstart(envPrefix: string, packageName: string): string {
  return [
    "### Bearer token",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(",
    "  new Client({",
    "    baseUrl: \"https://api.example.com\",",
    `    auth: { kind: "bearer", token: process.env.${envPrefix}_TOKEN! },`,
    "  }),",
    ");",
    "```",
  ].join("\n");
}

function buildApiKeyQuickstart(envPrefix: string, packageName: string): string {
  return [
    "### API key",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(",
    "  new Client({",
    "    baseUrl: \"https://api.example.com\",",
    `    auth: { kind: "apiKey", key: process.env.${envPrefix}_API_KEY! },`,
    "  }),",
    ");",
    "```",
  ].join("\n");
}

function buildBasicQuickstart(envPrefix: string, packageName: string): string {
  return [
    "### HTTP Basic",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(",
    "  new Client({",
    "    baseUrl: \"https://api.example.com\",",
    "    auth: {",
    `      kind: "basic",`,
    `      username: process.env.${envPrefix}_USERNAME!,`,
    `      password: process.env.${envPrefix}_PASSWORD!,`,
    "    },",
    "  }),",
    ");",
    "```",
  ].join("\n");
}

function buildOauth2Quickstart(envPrefix: string, packageName: string): string {
  return [
    "### OAuth2 client credentials",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(",
    "  new Client({",
    "    baseUrl: \"https://api.example.com\",",
    "    auth: {",
    `      kind: "oauth2",`,
    `      clientId: process.env.${envPrefix}_CLIENT_ID!,`,
    `      clientSecret: process.env.${envPrefix}_CLIENT_SECRET!,`,
    "    },",
    "  }),",
    ");",
    "```",
    "",
    "The client fetches and caches access tokens automatically, refreshing on 401.",
  ].join("\n");
}

// ── tokenProvider section ─────────────────────────────────────────────────────

function buildTokenProviderSection(packageName: string): string {
  return [
    "## Custom token provider",
    "",
    "Use `tokenProvider` as an escape hatch for auth schemes not covered above",
    "(e.g. signed tokens, OIDC, proxy injection):",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(",
    "  new Client({",
    "    baseUrl: \"https://api.example.com\",",
    "    auth: {",
    `      kind: "tokenProvider",`,
    "      getToken: async () => yourTokenFetcher(),",
    "    },",
    "  }),",
    ");",
    "```",
  ].join("\n");
}

// ── Pagination section ────────────────────────────────────────────────────────

function buildPaginationSection(
  example: PagesExample | null,
  packageName: string,
): string {
  if (example === null) return "";
  // Derive the *Pages method name: "items.list" → "client.items.listPages()"
  const [namespace, methodBase] = example.accessor.split(".");
  const pagesCall = `client.${namespace}.${methodBase}Pages()`;
  const lines = [
    "## Pagination",
    "",
    "Operations with paginated results expose a `*Pages()` async-generator variant",
    "that yields one page of items at a time:",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(new Client({ baseUrl: \"https://api.example.com\", auth: { /* ... */ } }));",
    "",
    "// Iterate all pages — the generator fetches the next page on demand.",
    `for await (const page of ${pagesCall}) {`,
    "  console.log(page);",
    "}",
    "```",
  ];
  if (example.pageSizeParam !== null) {
    lines.push("");
    lines.push(`Pass \`{ query: { ${example.pageSizeParam}: N } }\` to control page size.`);
  }
  return lines.join("\n");
}

// ── Retries section ───────────────────────────────────────────────────────────

/**
 * Formats a sorted list of status codes into a compact human-readable string,
 * collapsing consecutive runs into "start–end" ranges (e.g. 502, 503, 504 → "502–504").
 * Exported so unit tests can exercise the formatter directly.
 */
export function formatStatusCodes(codes: readonly number[]): string {
  if (codes.length === 0) return "";
  const sorted = [...codes].sort((a, b) => a - b);
  const groups: Array<[number, number]> = [];
  let start = sorted[0]!;
  let end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const code = sorted[i]!;
    if (code === end + 1) {
      end = code;
    } else {
      groups.push([start, end]);
      start = code;
      end = code;
    }
  }
  groups.push([start, end]);
  return groups.map(([s, e]) => (s === e ? String(s) : `${s}–${e}`)).join(", ");
}

function buildRetriesSection(retries: RetriesConfig): string {
  const statusList = formatStatusCodes(retries.retryableStatus);
  const statusPhrase =
    statusList.length > 0
      ? ` on retryable status codes (${statusList})`
      : "";
  return [
    "## Retries",
    "",
    `Failed requests are retried automatically (up to ${retries.maxRetries} retries) for`,
    `idempotent methods${statusPhrase}.`,
    "POST/PATCH are retried only on 408 and 429.",
    "The `Retry-After` response header is honored when present.",
  ].join("\n");
}
