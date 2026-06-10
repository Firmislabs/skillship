// src/renderers/sdk-utils-auth.ts
// C3-owned sibling of sdk-utils.ts: auth-scheme extraction, overlay application,
// and synthesis helpers. Split out to keep sdk-utils.ts under the 300-line cap.

import type { AuthSchemeDescriptor } from "../sdk-plugins/runtime.js";
import type { CodegenOverlay } from "../overlays/codegen.js";

// ---- Minimal OAS doc shape (read-only, subset used by auth extractors) ----

interface OasClientCredentialsFlow {
  readonly tokenUrl?: string;
  readonly scopes?: Record<string, string>;
}
interface OasOauth2Flows {
  readonly clientCredentials?: OasClientCredentialsFlow;
}
export interface OasSecurityScheme {
  readonly type?: string;
  readonly scheme?: string;
  readonly in?: string;
  readonly name?: string;
  readonly flows?: OasOauth2Flows;
}
export interface OasComponents {
  readonly securitySchemes?: Record<string, OasSecurityScheme>;
}

// ---- Scheme mapping ----

/**
 * Maps a single OAS security scheme to an AuthSchemeDescriptor.
 * Never throws — unknown/unsupported types map to { kind: "external" }.
 */
export function mapSecurityScheme(id: string, s: OasSecurityScheme): AuthSchemeDescriptor {
  const type = s.type ?? "";
  const scheme = s.scheme ?? "";
  if (type === "http" && scheme === "bearer") return { kind: "bearer", id };
  if (type === "http" && scheme === "basic") return { kind: "basic", id };
  if (type === "apiKey") {
    const loc: "header" | "query" = s.in === "query" ? "query" : "header";
    const name = typeof s.name === "string" ? s.name : "Authorization";
    return { kind: "apiKey", id, in: loc, name };
  }
  if (type === "oauth2") {
    const cc = s.flows?.clientCredentials;
    const tokenUrl = typeof cc?.tokenUrl === "string" ? cc.tokenUrl : null;
    const scopes = cc?.scopes != null ? Object.keys(cc.scopes) : [];
    return { kind: "oauth2ClientCredentials", id, tokenUrl, scopes };
  }
  // openIdConnect, mutualTLS, unknown — mapped to external (no auto-inject)
  return { kind: "external", id, schemeType: type };
}

// ---- Overlay application ----

/**
 * Applies overlay overrides to a descriptor.
 *
 * - oauth2-client-credentials mode: forces descriptor to oauth2ClientCredentials
 *   (regardless of the OAS scheme kind). overlay.auth.tokenUrl fills a null tokenUrl.
 * - apiKey mode: when descriptor is already apiKey, overrides name/in/valuePrefix
 *   from the overlay. Other descriptor kinds are left unchanged.
 * - bearer mode: descriptor is left unchanged (no fields to override).
 */
export function applyOverlayToDescriptor(
  desc: AuthSchemeDescriptor,
  overlay: CodegenOverlay | undefined,
): AuthSchemeDescriptor {
  const overlayAuth = overlay?.auth;
  if (overlayAuth === undefined) return desc;

  if (overlayAuth.mode === "oauth2-client-credentials") {
    const existingTokenUrl =
      desc.kind === "oauth2ClientCredentials" ? desc.tokenUrl : null;
    const tokenUrl =
      typeof overlayAuth.tokenUrl === "string"
        ? overlayAuth.tokenUrl
        : existingTokenUrl;
    const scopes =
      desc.kind === "oauth2ClientCredentials" ? desc.scopes : [];
    return { kind: "oauth2ClientCredentials", id: desc.id, tokenUrl, scopes };
  }

  if (overlayAuth.mode === "apiKey" && desc.kind === "apiKey") {
    const loc: "header" | "query" =
      overlayAuth.in === "query" ? "query" : "header";
    const name =
      typeof overlayAuth.name === "string" ? overlayAuth.name : desc.name;
    const valuePrefix =
      typeof overlayAuth.valuePrefix === "string"
        ? overlayAuth.valuePrefix
        : desc.valuePrefix;
    return { kind: "apiKey", id: desc.id, in: loc, name, valuePrefix };
  }

  return desc;
}

// ---- Synthesis ----

/**
 * Maps overlay.auth.mode to the descriptor kind it targets.
 */
export function overlayTargetKind(mode: string): string {
  if (mode === "apiKey") return "apiKey";
  if (mode === "bearer") return "bearer";
  if (mode === "oauth2-client-credentials") return "oauth2ClientCredentials";
  return "";
}

/**
 * Synthesizes an AuthSchemeDescriptor from the overlay when no scheme of the
 * overlay's target kind was produced from the OAS document.
 */
export function synthesizeDescriptor(
  overlay: CodegenOverlay,
): AuthSchemeDescriptor | null {
  const auth = overlay.auth;
  if (auth === undefined) return null;

  if (auth.mode === "apiKey") {
    const loc: "header" | "query" = auth.in === "query" ? "query" : "header";
    return {
      kind: "apiKey",
      id: "overlay_apikey",
      in: loc,
      name: auth.name ?? "X-API-Key",
      valuePrefix: auth.valuePrefix ?? "",
    };
  }

  if (auth.mode === "bearer") {
    return { kind: "bearer", id: "overlay_bearer" };
  }

  if (auth.mode === "oauth2-client-credentials") {
    const tokenUrl =
      typeof auth.tokenUrl === "string" ? auth.tokenUrl : null;
    return {
      kind: "oauth2ClientCredentials",
      id: "overlay_oauth2",
      tokenUrl,
      scopes: [],
    };
  }

  return null;
}
