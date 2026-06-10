// src/sdk-plugins/auth-emit.ts
// Line-array emission helpers for auth.ts. Split out so the auth.ts emitter
// source stays under the 300-line house rule while still owning the full
// AuthConfig + resolveAuthFromEnv + AuthManager + required-env-var surface.
//
// All exports return strings/string[] of EMITTED TypeScript; none run at SDK
// runtime. resolveAuthFromEnv ownership of env-var naming lives here too, so the
// runtime emitter can compose its ConfigError message from REQUIRED_ENV_VARS.
//
// C3: applyAuth branch emission moved to ./auth-emit-apply.ts (file-cap split).

import type { AuthSchemeDescriptor } from "./runtime.js";
import { buildApplyAuth } from "./auth-emit-apply.js";

// ─── resolveAuthFromEnv + required-env-var surface ───────────────────────────

export function buildResolveAuthFromEnv(
  schemes: readonly AuthSchemeDescriptor[],
  prefix: string,
): string {
  const branches = buildEnvBranches(schemes, prefix);
  return [
    "export function resolveAuthFromEnv(): AuthConfig | null {",
    "  const env = process.env;",
    ...branches,
    "  return null;",
    "}",
    "",
    buildRequiredEnvVars(schemes, prefix),
  ].join("\n");
}

/**
 * Emits a baked, deterministic list of the env vars resolveAuthFromEnv inspects,
 * grouped per scheme (so a ConfigError can tell the caller which to set). The
 * runtime emitter imports this and renders the "no auth provided" message.
 */
function buildRequiredEnvVars(
  schemes: readonly AuthSchemeDescriptor[],
  prefix: string,
): string {
  const vars = collectEnvVarNames(schemes, prefix);
  const literal = vars.map((v) => `"${v}"`).join(", ");
  return `export const REQUIRED_ENV_VARS: readonly string[] = [${literal}];`;
}

/**
 * The canonical, deterministic list of auth env-var NAMES that
 * resolveAuthFromEnv inspects (and that REQUIRED_ENV_VARS bakes in). Exported so
 * the MCP server emitter can bake the SAME names into describe_operation's auth
 * line — they MUST byte-match REQUIRED_ENV_VARS, so this is the single source.
 * Do NOT re-derive scheme→var mapping anywhere else.
 */
export function collectEnvVarNames(
  schemes: readonly AuthSchemeDescriptor[],
  prefix: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of schemes) {
    if (s.kind === "bearer" && !seen.has("bearer")) {
      seen.add("bearer");
      out.push(`${prefix}_TOKEN`);
    } else if (s.kind === "apiKey" && !seen.has("apiKey")) {
      seen.add("apiKey");
      out.push(`${prefix}_API_KEY`);
    } else if (s.kind === "basic" && !seen.has("basic")) {
      seen.add("basic");
      out.push(`${prefix}_USERNAME`, `${prefix}_PASSWORD`);
    } else if (s.kind === "oauth2ClientCredentials" && !seen.has("oauth2")) {
      seen.add("oauth2");
      out.push(`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`);
    }
  }
  return out;
}

function buildEnvBranches(
  schemes: readonly AuthSchemeDescriptor[],
  prefix: string,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const s of schemes) {
    if (s.kind === "bearer" && !seen.has("bearer")) {
      seen.add("bearer");
      lines.push(`  if (env.${prefix}_TOKEN) {`);
      lines.push(`    return { kind: "bearer", token: env.${prefix}_TOKEN };`);
      lines.push("  }");
    } else if (s.kind === "apiKey" && !seen.has("apiKey")) {
      seen.add("apiKey");
      lines.push(`  if (env.${prefix}_API_KEY) {`);
      lines.push(`    return { kind: "apiKey", value: env.${prefix}_API_KEY, in: "${s.in}", name: "${s.name}" };`);
      lines.push("  }");
    } else if (s.kind === "basic" && !seen.has("basic")) {
      seen.add("basic");
      lines.push(`  if (env.${prefix}_USERNAME && env.${prefix}_PASSWORD) {`);
      lines.push(`    return { kind: "basic", username: env.${prefix}_USERNAME, password: env.${prefix}_PASSWORD };`);
      lines.push("  }");
    } else if (s.kind === "oauth2ClientCredentials" && !seen.has("oauth2")) {
      seen.add("oauth2");
      lines.push(...buildOauth2EnvBranch(s, prefix));
    }
  }
  return lines;
}

function buildOauth2EnvBranch(
  s: Extract<AuthSchemeDescriptor, { kind: "oauth2ClientCredentials" }>,
  prefix: string,
): string[] {
  const defaultUrl = s.tokenUrl !== null ? `"${s.tokenUrl}"` : "undefined";
  const bakedScopes =
    s.scopes.length > 0 ? `, scopes: ["${s.scopes.join('", "')}"]` : "";
  return [
    `  if (env.${prefix}_CLIENT_ID && env.${prefix}_CLIENT_SECRET) {`,
    `    const tokenUrl = env.${prefix}_TOKEN_URL ?? ${defaultUrl};`,
    `    return { kind: "oauth2", clientId: env.${prefix}_CLIENT_ID, clientSecret: env.${prefix}_CLIENT_SECRET, tokenUrl${bakedScopes} };`,
    "  }",
  ];
}

// ─── AuthManager ─────────────────────────────────────────────────────────────

export function buildAuthManager(schemes: readonly AuthSchemeDescriptor[]): string {
  const hasOauth2 = schemes.some((s) => s.kind === "oauth2ClientCredentials");
  const fields = buildManagerFields(hasOauth2);
  const applyAuth = buildApplyAuth(schemes);
  const onUnauthorized = buildOnUnauthorized(hasOauth2);
  const tokenFetch = hasOauth2 ? buildFetchToken(schemes) : "";
  const invalidate = buildInvalidate(hasOauth2);
  return [
    "export class AuthManager {",
    "  private readonly auth: AuthConfig;",
    "  private readonly fetchImpl: typeof fetch;",
    ...fields,
    "",
    "  constructor(auth: AuthConfig, fetchImpl: typeof fetch) {",
    "    this.auth = auth;",
    "    this.fetchImpl = fetchImpl;",
    "  }",
    "",
    applyAuth,
    "",
    onUnauthorized,
    ...(invalidate ? ["", invalidate] : []),
    ...(tokenFetch ? ["", tokenFetch] : []),
    "}",
  ].join("\n");
}

function buildManagerFields(hasOauth2: boolean): string[] {
  if (!hasOauth2) return [];
  return [
    "  private cachedToken: { token: string; expiresAt: number } | null = null;",
    "  private inflight: Promise<string> | null = null;",
  ];
}

function buildOnUnauthorized(hasOauth2: boolean): string {
  if (hasOauth2) {
    return [
      "  onUnauthorized(): boolean {",
      '    if (this.auth.kind === "oauth2" || this.auth.kind === "tokenProvider") {',
      "      this.invalidate();",
      "      return true;",
      "    }",
      "    return false;",
      "  }",
    ].join("\n");
  }
  return [
    "  onUnauthorized(): boolean {",
    '    if (this.auth.kind === "tokenProvider") {',
    "      return true;",
    "    }",
    "    return false;",
    "  }",
  ].join("\n");
}

function buildInvalidate(hasOauth2: boolean): string {
  if (!hasOauth2) return "";
  return [
    "  invalidate(): void {",
    "    this.cachedToken = null;",
    "    this.inflight = null;",
    "  }",
  ].join("\n");
}

function buildFetchToken(schemes: readonly AuthSchemeDescriptor[]): string {
  const oauth2 = schemes.find(
    (s): s is Extract<AuthSchemeDescriptor, { kind: "oauth2ClientCredentials" }> =>
      s.kind === "oauth2ClientCredentials",
  );
  const url = oauth2?.tokenUrl != null ? `"${oauth2.tokenUrl}"` : "undefined";
  return buildGetOauth2Token(url, oauth2?.scopes ?? []);
}

function buildGetOauth2Token(defaultUrl: string, scopes: readonly string[]): string {
  // Always emit scope lines: the AuthConfig union advertises `scopes?: string[]`
  // unconditionally, so user-supplied scopes must always be forwarded. When the
  // OAS descriptor has no scopes, the baked default is "" and the `if (scopeStr)`
  // guard ensures no `scope=` param is sent unless the user provides scopes.
  const bakedDefault = scopes.length > 0 ? scopes.join(" ") : "";
  const scopeLines = [
    `    const scopeStr = this.auth.scopes?.join(" ") ?? "${bakedDefault}";`,
    '    if (scopeStr) { body.set("scope", scopeStr); }',
  ];
  return [
    "  private getOauth2Token(): Promise<string> {",
    "    const now = Date.now();",
    "    if (this.cachedToken && this.cachedToken.expiresAt > now) {",
    "      return Promise.resolve(this.cachedToken.token);",
    "    }",
    "    if (this.inflight) return this.inflight;",
    "    const inflight = this.fetchOauth2Token(now).finally(() => {",
    "      if (this.inflight === inflight) this.inflight = null;",
    "    });",
    "    this.inflight = inflight;",
    "    return inflight;",
    "  }",
    "",
    "  private async fetchOauth2Token(now: number): Promise<string> {",
    '    if (this.auth.kind !== "oauth2") throw new ConfigError("auth kind mismatch");',
    `    const url = this.auth.tokenUrl ?? ${defaultUrl};`,
    '    if (!url) throw new ConfigError("tokenUrl is required for oauth2 but was not provided");',
    "    const { clientId, clientSecret } = this.auth;",
    "    const credentials = btoa(`${clientId}:${clientSecret}`);",
    "    const body = new URLSearchParams();",
    '    body.set("grant_type", "client_credentials");',
    ...scopeLines,
    "    const res = await this.fetchImpl(url, {",
    '      method: "POST",',
    '      headers: { "Authorization": `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },',
    "      body: body.toString(),",
    "    });",
    "    if (!res.ok) {",
    "      throw new AuthError(`token endpoint returned ${res.status}: ${url}`);",
    "    }",
    "    const json = await res.json() as Record<string, unknown>;",
    '    const token = json["access_token"];',
    '    if (typeof token !== "string") throw new AuthError("malformed token response");',
    '    const expires_in = typeof json["expires_in"] === "number" ? json["expires_in"] : undefined;',
    "    this.cachedToken = { token, expiresAt: now + (expires_in ?? 300) * 1000 - 60 * 1000 };",
    "    return token;",
    "  }",
  ].join("\n");
}
