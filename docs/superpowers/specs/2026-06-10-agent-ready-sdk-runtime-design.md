# Agent-Ready SDK Runtime — Design (Spec A)

**Date:** 2026-06-10
**Status:** Approved design, pre-plan
**Repo:** skillship
**Predecessors:** Plan 2 (R-SDK TypeScript wedge), 2026-05-28 multi-language SDK (Fern Python/Rust)
**Successor:** Spec B — MCP server renderer (R-MCP, separate spec; depends on this work)

## 1. Goal

Make the generated SDKs complete enough that an AI agent (or any machine-to-machine
caller) can authenticate, survive rate limits, and traverse list endpoints against a
real API — across all three supported languages (TypeScript native, Python + Rust via
Fern). SLC statement for the wider MVP: **"one command and your product works in
Claude Code/Cursor in under ten minutes, even from docs-only input."** This spec
covers the SDK-runtime half; the MCP server renderer (Spec B) covers the agent
connector half and consumes this work.

Three capabilities, in priority order:

1. **Auth that never fails the build** — OAuth2 client-credentials + token-provider
   escape hatch + env-var pickup. Today `oauth2`/`openIdConnect`/`mutualTLS` schemes
   throw a hard error and abort SDK generation entirely.
2. **Retries** — exponential backoff with jitter, `Retry-After` honored, method-aware.
3. **Pagination** — cursor/offset/page iteration helpers, overlay-driven with
   conservative auto-detection.

## 2. Locked decisions (user-approved 2026-06-10)

- **Languages:** existing three only (TS native, Python + Rust via Fern Docker). No new languages.
- **OAuth scope:** client-credentials flow built in + async `tokenProvider` callback.
  Device/browser login, token disk cache: **deferred to v1.1**.
- **Approach:** single source of truth, dual emission. Features defined once
  (overlay + synthetic OAS), emitted natively in the TS runtime plugin and translated
  into Fern's native mechanisms (`x-fern-pagination`, Fern OAuth scheme config, Fern
  retry knobs) for Python/Rust. No post-processing of Fern output, ever.
- **Decomposition:** this is Spec A of two. Spec B (MCP renderer) is brainstormed
  separately after A ships.
- **Cut:** streaming, webhooks, idempotency-key auto-generation, publishing
  automation, new languages, CLI generation, signing/auto-update, docs hosting.

## 3. Current state (verified anchors)

- Hard throw on unsupported schemes: `src/renderers/sdk-utils.ts:54-58`
  (`extractAuthSchemes` throws for `oauth2`, `openIdConnect`, `mutualTLS`).
- Supported descriptors: `src/sdk-plugins/runtime.ts:9-12` — `bearer`,
  `apiKey` (header|query), `basic`.
- Generated `AuthConfig` is **scheme-driven per product**: the golden
  `tests/fixtures/golden/sdk-minimal/src/runtime.ts:4` emits only
  `{ kind: "bearer"; token: string }` because the fixture declares only bearer.
- Generated `request()` (golden `runtime.ts:40-122`): inline auth injection, timeout
  via AbortController, `onRequest`/`onResponse` hooks. No retry loop.
- Overlay schema `src/overlays/codegen.ts` already defines (unconsumed):
  - `Auth { mode: bearer|apiKey|oauth2-client-credentials, in, name }`
  - `Retries { maxRetries=2, backoff: exponential-jitter, honorRetryAfter=true, idempotencyHeader, retryableStatus=[408,409,429,500,502,503,504] }`
  - `Pagination { style: cursor|offset|page, fields, perOperation }`
- Synthetic OAS emits `oauth2` securitySchemes with placeholder `flows: {}`
  (`src/renderers/oas.ts:167-179`); the graph carries `flows` as a claim on
  `AuthSchemeNode` (`src/graph/types.ts:144-150`) but the OAS renderer drops it.
- Fern path: `src/renderers/fern-project.ts` (generators.yml) +
  `src/renderers/fern-oas-rewrite.ts` (operationId/tags rewrite via
  `resolveAssignments`). No pagination/retry/auth config passed to Fern today.
- Pinned Fern toolchain: CLI `fern-api@5.40.0`, `fernapi/fern-python-sdk:5.14.4`,
  `fernapi/fern-rust-sdk:0.36.8` (`src/renderers/fern-images.ts`).

## 4. Design

### 4.1 Auth

**Never fail the build on an auth scheme.** `extractAuthSchemes` stops throwing.
The descriptor union (`src/sdk-plugins/runtime.ts`) grows:

```ts
export type AuthSchemeDescriptor =
  | { readonly kind: "bearer"; readonly id: string }
  | { readonly kind: "apiKey"; readonly id: string; readonly in: "header" | "query"; readonly name: string }
  | { readonly kind: "basic"; readonly id: string }
  | { readonly kind: "oauth2ClientCredentials"; readonly id: string; readonly tokenUrl: string | null; readonly scopes: readonly string[] }
  | { readonly kind: "external"; readonly id: string; readonly schemeType: string };
```

Mapping from OAS `securitySchemes`:

| OAS scheme | Descriptor |
|---|---|
| `http`+`bearer` | `bearer` (unchanged) |
| `http`+`basic` | `basic` (unchanged) |
| `apiKey` | `apiKey` (unchanged) |
| `oauth2` with `flows.clientCredentials` | `oauth2ClientCredentials` (tokenUrl from the flow) |
| `oauth2` other/empty flows | `oauth2ClientCredentials` with `tokenUrl: null` (user must supply `tokenUrl` or use tokenProvider) |
| `openIdConnect`, `mutualTLS`, unknown | `external` — SDK still builds; README documents the tokenProvider path |

To make real `tokenUrl`s flow end-to-end, the OAS renderer
(`src/renderers/oas.ts:securitySchemeFor`) is extended to project the graph's
`flows` claim into the `oauth2` securityScheme instead of stamping `flows: {}`.
When the graph has no flow data, `flows: {}` stays (descriptor gets `tokenUrl: null`).
The overlay `auth.mode: "oauth2-client-credentials"` can force the oauth2 descriptor
and the overlay gains an optional `tokenUrl` field for vendors whose specs omit it.

**Generated TS runtime.** The per-product `AuthConfig` union now always includes
`tokenProvider`, plus one member per declared scheme:

```ts
export type AuthConfig =
  | { kind: "bearer"; token: string }                       // when declared
  | { kind: "oauth2"; clientId: string; clientSecret: string;
      tokenUrl?: string; scopes?: string[] }                // when oauth2 declared
  | { kind: "tokenProvider"; getToken: () => Promise<string> }; // always
```

OAuth2 client-credentials behavior (generated `src/auth.ts`, new file):

- POST `tokenUrl` with `grant_type=client_credentials` (+ `scope` when set),
  client auth via HTTP Basic header (RFC 6749 §2.3.1), body
  `application/x-www-form-urlencoded`.
- Cache the token with expiry `now + expires_in − 60s` skew; missing `expires_in`
  → conservative 300s.
- **Single-flight refresh:** concurrent requests share one in-flight token fetch
  (cache the promise).
- On a 401 API response with an oauth2/tokenProvider config: invalidate the cache and
  retry the request **once** with a fresh token. This 401 retry is separate from and
  not counted against `maxRetries`.
- Token-endpoint failure → typed `AuthError` carrying HTTP status and the token
  endpoint URL. Never include `clientSecret` in any error message.

**Env-var pickup.** `auth` becomes optional in `ClientOptions`. When omitted, the
constructor resolves credentials from env vars using a deterministic prefix —
`UPPER_SNAKE(productId)` (the existing sanitized product slug, uppercased,
non-alphanumerics → `_`):

| Scheme | Env vars |
|---|---|
| bearer | `<PREFIX>_TOKEN` |
| apiKey | `<PREFIX>_API_KEY` |
| basic | `<PREFIX>_USERNAME`, `<PREFIX>_PASSWORD` |
| oauth2 | `<PREFIX>_CLIENT_ID`, `<PREFIX>_CLIENT_SECRET`, optional `<PREFIX>_TOKEN_URL` |

Resolution order: explicit `auth` option > env vars (first declared scheme whose
required vars are all present, in OAS declaration order). Neither present → throw a
construction-time `ConfigError` listing the exact env var names accepted. The
generated README documents the table. This is the "agent sets env vars, zero code"
path.

**Python/Rust (Fern).** Fern supports OAuth client-credentials via an
`auth-schemes` entry in `generators.yml`/api config, but its standard mechanism
expects the token endpoint to exist as an operation in the spec. Whether the pinned
generators (python 5.14.4, rust 0.36.8) support it against our synthetic OAS is
**Spike S1** (§6). Fallback if infeasible: Python/Rust keep bearer/apiKey/basic
natively, README documents a 10-line client-credentials snippet (fetch token, pass
as bearer), and the gap is recorded in KNOWN_GAPS.md. The TS path does not depend
on this spike.

### 4.2 Retries

Generated TS runtime grows a retry loop around the fetch call, driven by the overlay
`Retries` schema (defaults as already defined: `maxRetries: 2`, exponential backoff
with full jitter, `retryableStatus: [408, 409, 429, 500, 502, 503, 504]`,
`honorRetryAfter: true`):

- Backoff: `delay = random(0, min(cap, base * 2^attempt))` with `base = 500ms`,
  `cap = 30s` (full jitter, AWS style). `Retry-After` (seconds or HTTP-date), when
  present and honored, **overrides** the computed delay, still capped at 30s.
- **Method awareness:** idempotent methods (GET/HEAD/PUT/DELETE/OPTIONS) retry on
  the full `retryableStatus` list and on network errors (fetch rejection).
  Non-idempotent methods (POST/PATCH) retry **only** on 408/429 and never on
  network errors (the request may have been applied).
- Timeout applies **per attempt** (existing AbortController per try); a timeout on
  an idempotent method counts as retryable.
- Exhaustion: re-throw the final typed error; the thrown error message includes
  attempt count (e.g. `"... (after 3 attempts)"`).
- Injectable for tests: the sleep function is a module-level indirection in the
  generated runtime (`const sleep = (ms) => new Promise(...)`, overridable via a
  `ClientOptions.sleep?` escape hatch) so unit tests run with zero real delay.
- Hook ordering unchanged: `onRequest` runs before each attempt's fetch (a fresh
  `Request` is constructed per attempt — Request bodies are single-use);
  `onResponse` runs on the final returned response only.

**Python/Rust (Fern).** Fern-generated clients ship retry behavior natively
(`max_retries` request option in Python; Rust equivalent). **Spike S3** (§6)
verifies what's on by default in the pinned generators and which knobs
`generators.yml` exposes; we configure to approximate the overlay defaults and
record any unbridgeable differences in the README + KNOWN_GAPS.md rather than
post-processing output.

### 4.3 Pagination

**Shared detection, one module:** `src/renderers/pagination-detect.ts` exports
`detectPagination(ops, oasJson, overlay): ReadonlyMap<string, PaginationPlan>`
consumed by **both** the TS plugin and the Fern OAS rewrite — the same
single-source-of-truth pattern as `resolveAssignments`, so the three languages
agree on which operations paginate and how.

```ts
export interface PaginationPlan {
  readonly style: "cursor" | "offset" | "page";
  readonly requestParam: string;        // cursor / offset / page param name
  readonly pageSizeParam: string | null;
  readonly itemsField: string;          // response array property
  readonly nextField: string | null;    // cursor style: response next-cursor property
}
```

Resolution order per operation:

1. `overlay.pagination.perOperation[opId]` (style) + `overlay.pagination.fields`
   (field names) — explicit always wins.
2. `overlay.pagination.style` as product-wide default, fields from
   `overlay.pagination.fields`.
3. **Conservative auto-detection** (only when the overlay is silent): a GET
   operation whose 200-response schema is an object with **exactly one** array
   property qualifies if additionally:
   - cursor style: response has a sibling property named `next_cursor`, `nextCursor`,
     `next_page_token`, or `cursor`, AND the request has a string query param named
     `cursor`, `page_token`, or `starting_after`; or
   - page style: request has integer query params `page` + (`per_page`|`page_size`); or
   - offset style: request has integer query params `offset` + `limit`.
   Anything ambiguous (zero or 2+ array properties, no matching param pair) → **no
   pagination**. False negatives are acceptable; false positives are not.

**Generated TS surface:** for each op with a plan, emit a sibling
`<method>Pages(args): AsyncGenerator<Item>` alongside the unchanged plain method.
The generator (generated `src/pagination.ts` + per-op glue in `resources.ts`):

- yields items from `itemsField` page by page;
- cursor style: stops on missing/null/empty `nextField`; **infinite-loop guard:**
  stops (with no error) if the next cursor equals the current cursor;
- offset/page style: stops when a page returns fewer items than requested (or zero);
- each underlying page request goes through the normal `request()` path (auth,
  retries, hooks all apply).

**Python/Rust (Fern):** for each op with a plan, `buildFernOas` stamps the
corresponding `x-fern-pagination` extension (cursor/offset variants per Fern's
documented syntax) into the rewritten OAS, and Fern emits its native pagers.
**Spike S2** (§6) verifies both pinned generators accept the extension and what
they emit; fallback per language: omit the extension (plain methods only) and
record the asymmetry in KNOWN_GAPS.md.

### 4.4 File structure

Generated TS SDK (new layout — goldens regenerate):

```
src/
  runtime.ts      # Client, ClientOptions, request loop w/ retries (<300 lines)
  auth.ts         # AuthConfig union, env pickup, token cache, AuthError, ConfigError
  pagination.ts   # generic paginate() async-generator engine
  resources.ts    # unchanged role; adds *Pages() methods where planned
  errors.ts       # + AuthError, ConfigError
  ...
```

Our source:

```
src/sdk-plugins/runtime.ts       # grows: retry loop emission (split if >300 lines)
src/sdk-plugins/auth.ts          # NEW: emits generated auth.ts
src/sdk-plugins/pagination.ts    # NEW: emits generated pagination.ts + resources glue
src/renderers/pagination-detect.ts  # NEW: shared detection (TS plugin + Fern rewrite)
src/renderers/sdk-utils.ts       # extractAuthSchemes: extended mapping, no throws
src/renderers/oas.ts             # securitySchemeFor: project real oauth2 flows
src/renderers/fern-oas-rewrite.ts   # + x-fern-pagination stamping
src/renderers/fern-project.ts    # + auth-schemes / retry config (spike-gated)
src/overlays/codegen.ts          # Auth gains optional tokenUrl; Pagination fields documented
```

House rules apply: functions ≤50 lines, files ≤300 lines (split generated output
along the module boundaries above), no `any`, explicit return types on exports.

### 4.5 Error handling summary

| Failure | Behavior |
|---|---|
| Unsupported auth scheme in spec | Build succeeds; descriptor `external`; README documents tokenProvider |
| No auth option + no env vars | Construction-time `ConfigError` listing expected env var names |
| Token endpoint returns non-2xx | `AuthError` (status + endpoint URL, secret never echoed) |
| Token response missing `access_token` | `AuthError` ("malformed token response") |
| 401 with oauth2/tokenProvider | One forced-refresh retry, then `AuthenticationError` |
| Retry exhaustion | Final typed error re-thrown, message notes attempt count |
| `Retry-After` unparseable | Fall back to computed backoff |
| Pagination cursor repeats | Stop iteration cleanly (no error, no infinite loop) |
| Page response missing `itemsField` | Typed error naming the field and operation |

### 4.6 Testing

- **TDD throughout** (RED → GREEN → REFACTOR), per house rules.
- **Unit tests, zero network/timers:** injected `fetch` fakes + injected sleep.
  Token cache/single-flight tested with controlled promise resolution. Retry
  schedules asserted on recorded sleep calls (jitter tested via seeded bounds:
  assert `0 ≤ delay ≤ min(cap, base·2^attempt)`).
- **Golden trees:** TS goldens regenerate (new `auth.ts`/`pagination.ts`, runtime
  growth) — diffs reviewed by category, then byte-locked as today. The
  `sdk-minimal` fixture gains an oauth2 + paginated-list operation variant **or**
  a third fixture `sdk-agent-minimal` is added (plan decides; bias to a third
  fixture so existing goldens stay byte-stable).
- **Fern goldens:** regenerate through the existing Docker lane
  (`.github/workflows/sdk-docker.yml`), `cargo check` + `python -m compileall`
  gates unchanged; manifest locks updated.
- **tsc gate:** every TS golden still typechecks via the existing
  `tsc --noEmit` gate.
- **Determinism:** generation remains byte-deterministic — all new generated code
  is static templates parameterized only by graph/overlay data. Token expiry math
  runs at SDK runtime, not generation time.

## 5. What this explicitly does NOT do

- No streaming/SSE, no webhook signature verification (deferred, overlay schema
  retained for later).
- No device/browser OAuth, no token disk cache (v1.1).
- No idempotency-key auto-generation (header passthrough already works).
- No MCP server (Spec B), no CLI generation (v1.1), no publishing automation.
- No post-processing of Fern output — Fern features are config/extension-driven
  only; gaps become documented asymmetries, not hand-rolled patches.

## 6. Plan-phase verification spikes (sequence first, fold results into the plan)

- **S1 — Fern OAuth client-credentials:** stand up the spike Fern project with an
  oauth2 scheme; determine whether python 5.14.4 / rust 0.36.8 support
  `auth-schemes` client-credentials against our synthetic OAS (incl. the
  token-endpoint-as-operation requirement). Outcome: config recipe per language,
  or documented fallback (bearer + README snippet).
- **S2 — `x-fern-pagination`:** stamp cursor + offset variants into the spike OAS;
  verify both pinned generators accept it and inspect emitted pager API. Outcome:
  exact extension syntax per style, or per-language fallback (omit).
- **S3 — Fern retry knobs:** determine default retry behavior and configurable
  knobs in the pinned generators. Outcome: generators.yml config approximating
  overlay defaults + documented differences.

Spikes run via the existing Docker lane tooling (`skillship sdk warm` +
`npx fern-api@5.40.0 generate --local`). If a spike forces a generator version
bump, the bump is its own reviewed change with regenerated goldens.

## 7. Success criteria

1. A build against a fixture declaring `oauth2` **succeeds** (today it throws), and
   the emitted TS SDK authenticates via client-credentials against a mock fetch in
   tests: token fetched once, cached, single-flighted, refreshed on 401.
2. `new Client({ baseUrl })` with only env vars set works; with nothing set, the
   error names the exact env vars.
3. A 429 with `Retry-After: 1` is retried after the header-specified delay (recorded
   sleep), succeeds on attempt 2; a POST is not retried on 500.
4. A cursor-paginated fixture iterates 3 pages via `*Pages()` and stops cleanly;
   the repeated-cursor guard test passes.
5. Python and Rust golden trees regenerate deterministically with whatever
   spike-confirmed feature set; manifest locks + compile gates green.
6. Full suite green (`npm test` exit 0), typecheck green, zero regressions in
   existing goldens other than reviewed regenerations.
7. KNOWN_GAPS.md records every spike fallback taken and the v1.1 deferrals.
