// src/sdk-plugins/runtime.ts
// Hey API custom plugin: emits the Client class, fetch wrapper, and the retry
// loop. Auth schemes are projected from the synthetic OpenAPI's
// components.securitySchemes (via Plan 1/1.5 substrate), but the AuthConfig
// union + injection now live entirely in the emitted ./auth.js (Task 5); this
// emitter imports them and delegates header injection to AuthManager.applyAuth.
//
// Retry contract (spec §5.3 / §5.10): full-jitter exponential backoff, optional
// Retry-After honoring, method-class-aware retryability, fresh Request per
// attempt, and a single auth-refresh retry OUTSIDE the retry counter.
//
// String-emission helpers live in ./runtime-emit.ts so this file stays under
// the 300-line house rule.

import {
  emitBackoff,
  emitBuildRequest,
  emitClassOpen,
  emitClientOptions,
  emitConstants,
  emitConstructor,
  emitDefaultSleep,
  emitExecuteWithAuthRefresh,
  emitHeader,
  emitRequestLoop,
  emitRequestMethod,
  emitRetryAfter,
  emitRetryability,
} from "./runtime-emit.js";

export type AuthSchemeDescriptor =
  | { readonly kind: "bearer"; readonly id: string }
  | { readonly kind: "apiKey"; readonly id: string; readonly in: "header" | "query"; readonly name: string }
  | { readonly kind: "basic"; readonly id: string }
  | { readonly kind: "oauth2ClientCredentials"; readonly id: string; readonly tokenUrl: string | null; readonly scopes: readonly string[] }
  | { readonly kind: "external"; readonly id: string; readonly schemeType: string };

/** Retry behavior, sourced from the codegen overlay (`overlay.retries`). */
export interface RetriesConfig {
  readonly maxRetries: number;
  readonly retryableStatus: readonly number[];
  readonly honorRetryAfter: boolean;
}

const DEFAULT_RETRIES: RetriesConfig = {
  maxRetries: 2,
  retryableStatus: [408, 409, 429, 500, 502, 503, 504],
  honorRetryAfter: true,
};

export function generateRuntimeModule(
  schemes: readonly AuthSchemeDescriptor[],
  retries: RetriesConfig = DEFAULT_RETRIES,
): string {
  // `schemes` no longer drives runtime branching — auth.ts owns the AuthConfig
  // union and header injection. The parameter is retained for signature
  // stability and to keep the auth/runtime contract co-located at the call site.
  void schemes;
  return [
    emitHeader(),
    emitConstants(retries),
    emitDefaultSleep(),
    emitClientOptions(),
    emitClassOpen(),
    emitConstructor(),
    emitRequestMethod(),
    emitBuildRequest(),
    emitExecuteWithAuthRefresh(),
    emitRequestLoop(),
    emitBackoff(),
    emitRetryAfter(),
    emitRetryability(),
    "}",
    "",
  ].join("\n");
}
