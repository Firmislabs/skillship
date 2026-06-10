// src/renderers/sdk-templates/render-auth.ts
// Auth-section builders extracted from render.ts to stay under the 300-line cap.
// Exports: buildEnvTable, envRows, buildAuthQuickstart, buildTokenProviderSection.
import type { AuthSchemeDescriptor } from "../../sdk-plugins/runtime.js";

// ── Env-var table ────────────────────────────────────────────────────────────

export function buildEnvTable(
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

export function envRows(
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

export function buildAuthQuickstart(
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

export function buildTokenProviderSection(packageName: string): string {
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
