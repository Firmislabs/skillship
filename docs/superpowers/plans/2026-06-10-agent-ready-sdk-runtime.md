# Agent-Ready SDK Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generated SDKs (TS native, Python+Rust via Fern) gain working auth (OAuth2 client-credentials + tokenProvider + env pickup — no scheme ever fails the build), retries (backoff/jitter/Retry-After, method-aware), and pagination (`*Pages()` async iterators, shared detection), per the approved spec at `docs/superpowers/specs/2026-06-10-agent-ready-sdk-runtime-design.md`.

**Architecture:** Single source of truth, dual emission. Auth descriptors and pagination plans are computed once from the synthetic OAS + overlay, then consumed by both the TS plugin pipeline and the Fern OAS rewrite — the same pattern as `resolveAssignments`. Generated TS splits into `runtime.ts`/`auth.ts`/`pagination.ts`. Fern features ride Fern-native config verified by spike (results below).

**Tech Stack:** TypeScript (Node ≥20, ESM, strict), vitest, zod (overlay), Fern CLI 5.45.3 + fernapi/fern-python-sdk 5.14.12 + fernapi/fern-rust-sdk 0.40.4 (Docker, pinned), existing golden/manifest-lock test infrastructure.

**Worktree:** `/Users/riteshkewlani/github/skillship/.worktrees/agent-sdk-runtime`, branch `agent-sdk-runtime`.

---

## Spike outcomes (already executed 2026-06-10 — fold-in, do not re-run)

**S0 (unplanned, blocking): the pinned Fern toolchain is broken upstream.**
Fern's registry now declares generator `fern-python-sdk:5.14.4` incompatible with CLI 5.40.0 ("requires CLI version 5.44.6 or later"). The nightly `sdk-docker.yml` lane has been failing since ≥2026-06-05 with exactly this error. The CLI reads the version from `fern.config.json`'s `version` field (not from the npx package version), so the fix must update `FERN_PINS.cliVersion`. **Task 1 repairs this before anything else.** Verified working combination: CLI **5.45.3** + python **5.14.12** + rust **0.40.4**.

New image digests (record-only, generation pins by tag):
- `fernapi/fern-python-sdk:5.14.12` = `sha256:2a2eb231fcb8726abc42f9a6244b65beb9376a59ad98cc87b5853ec85b5f8a1b`
- `fernapi/fern-rust-sdk:0.40.4` = `sha256:62f87e526256e9378cc844ef9084392235968239d2c6cf5bd6fee59698f3d1bb`

**S1 (Fern OAuth client-credentials): Rust YES, Python NO.**
With this `generators.yml` api-level block, generation succeeds (exit 0) and **Rust** emits a full OAuth stack: `ApiClientBuilder::client_id/client_secret/oauth_credentials(...)` + `core/oauth_token_provider.rs` (token cache, expiry buffer 120s, default expiry 3600s, double-checked locking). **Python 5.14.12 ignores the OAuth IR** — its client keeps `token: str | Callable[[], str]` (+ `async_token`); the token endpoint surfaces as a plain `auth` sub-client. Verified exact syntax (property refs MUST be `$request.`/`$response.`-prefixed, dot-delimited):

```yaml
auth-schemes:
  OAuth:
    scheme: oauth
    type: client-credentials
    get-token:
      endpoint: POST /oauth/token        # must reference an operation present in the OAS
      request-properties:
        client-id: $request.client_id
        client-secret: $request.client_secret
      response-properties:
        access-token: $response.access_token
        expires-in: $response.expires_in
api:
  auth: OAuth
  specs:
    - openapi: openapi/openapi.json
```

Constraints discovered: `get-token.endpoint` must name an operation that exists in the OAS (`METHOD /path`). `client-id-env`/`client-secret-env` keys are accepted by the CLI schema but **neither generator emits env-var wiring** — env pickup stays a TS-only feature. Python fallback: token callable + README client-credentials snippet.

**S2 (x-fern-pagination): parsed into the IR, NOT emitted by either pinned-candidate generator.**
The CLI converts per-endpoint `x-fern-pagination` (cursor and offset forms) correctly — `fern ir` output shows `endpoints[].pagination` nodes and `sdkConfig.hasPaginatedEndpoints: true`. But python 5.14.12 and rust 0.40.4 both emit plain methods (no `SyncPager`; rust's `core/pagination.rs` paginator classes are emitted as unused boilerplate). Root-cause investigation against Fern source: **see "S2 verdict" subsection below** (filled in from the investigation before plan execution). Plan default: **stamp the extension anyway** (forward-compatible, generation-verified harmless) but do not claim pager support; Python/Rust pagination is a documented asymmetry in KNOWN_GAPS.md unless the verdict provides a working recipe.

**S2 verdict (investigated against fern-api/fern source, 2026-06-10): no supported recipe — TS-only pagination, stamp the extension anyway.**
- **Python:** pager emission requires `GeneratorConfig.generatePaginatedClients`, which the CLI sets from a **server-side org entitlement** (Venus `paginationEnabled`); in `--local` mode without `FERN_TOKEN` it is hardcoded `false` (`runLocalGenerationForWorkspace.ts` ~line 394: `orgBody?.paginationEnabled ?? false`). No generators.yml key, api setting, or env var overrides it (full SDKCustomConfig audited — nothing pagination-enabling). The `core/pagination.py` boilerplate is emitted from the IR alone, which is why it appears while methods stay plain. Patching the compiled CLI bundle would work but is unsupported and breaks on every npx cache refresh — REJECTED for a deterministic pipeline.
- **Rust:** pager generation (`generatePaginatedMethods`) is dead code — the call site was deliberately removed upstream in PR #9781 (2025-10-07); both 0.36.8 and 0.40.4 post-date it. No flag reaches it.
- **Plan consequence:** Task 11 stamps `x-fern-pagination` from the shared plans (verified harmless at generation; auto-activates pagers on regen if Fern ever lifts the gates), Task 13 records "pagination helpers: TypeScript only; Python/Rust expose plain list methods with cursor/offset params" in KNOWN_GAPS.md and the Fern-side READMEs are not modified (Fern owns them).

**S3 (Fern retries): built-in, both languages, no config needed.**
Python: `max_retries` constructor param (default 2 — matches overlay default) + per-request `request_options.max_retries`; `core/http_client.py` honors `Retry-After`, then `X-RateLimit-Reset` (+jitter), then exponential backoff with jitter. Rust: `ClientConfig.max_retries` (default 3) + builder `max_retries(u32)` + retryable-status loop with exponential backoff. Documented difference: rust default is 3 vs overlay's 2; not configurable at generation time; record in KNOWN_GAPS.md, do not patch output.

**Spike artifacts:** `/tmp/fern-spike-agent` (runs 1–9, `run*.log`, `ir.json`). Disposable; key facts are recorded above.

---

## File map (created / modified)

| File | Role |
|---|---|
| `src/renderers/fern-images.ts` (M) | Pin bump: cliVersion 5.45.3, python 5.14.12, rust 0.40.4 + digests |
| `src/overlays/codegen.ts` (M) | `Auth` + optional `tokenUrl`; `Pagination.fields` → fixed-key object |
| `src/sdk-plugins/runtime.ts` (M) | Descriptor union grows; retry loop emission; auth injection delegates to generated `auth.ts`; emits `sleep` injection |
| `src/sdk-plugins/auth.ts` (C) | Emits generated `src/auth.ts` (AuthConfig union, env pickup, token cache, applyAuth) |
| `src/sdk-plugins/pagination.ts` (C) | Emits generated `src/pagination.ts` + per-op `*Pages` glue for resources |
| `src/sdk-plugins/errors.ts` (M) | Adds `AuthError`, `ConfigError` to emitted error module |
| `src/sdk-plugins/resource-tree.ts` (M) | Resource emission consumes pagination plans for `*Pages` methods |
| `src/renderers/pagination-detect.ts` (C) | Shared detection: ops + OAS + overlay → `Map<opId, PaginationPlan>` |
| `src/renderers/sdk-utils.ts` (M) | `extractAuthSchemes`: full mapping, never throws |
| `src/renderers/sdk.ts` (M) | Pipeline wires auth/pagination plugins + new generated files |
| `src/renderers/oas.ts` (M) | `securitySchemeFor`: project real oauth2 `flows` from graph claim |
| `src/renderers/fern-oas-rewrite.ts` (M) | Stamps `x-fern-pagination` per shared plans |
| `src/renderers/fern-project.ts` (M) | Conditional `auth-schemes` OAuth block + `api.auth` |
| `src/renderers/sdk-templates/README.md.tpl` (M) | Auth section: env-var table, oauth2/tokenProvider usage |
| `tests/fixtures/openapi3/agent-minimal.yaml` (C) | New ingest fixture spec (single file, repo convention): oauth2 cc scheme + token op + cursor-list + offset-list + plain POST; productName `agentmin` |
| `tests/fixtures/golden/sdk-agent-minimal/**` (C) | New TS golden tree + `.manifest.json` |
| `tests/fixtures/golden/sdk-{python,rust}-agent-minimal/**` (C) | New Fern golden trees + manifests |
| `tests/sdk-plugins/auth.test.ts` (C) | Source assertions on emitted auth module |
| `tests/sdk-plugins/pagination.test.ts` (C) | Source assertions on emitted pagination module |
| `tests/sdk-plugins/runtime.test.ts` (M) | Retry-loop + sleep-injection assertions |
| `tests/renderers/pagination-detect.test.ts` (C) | Unit tests for shared detection |
| `tests/renderers/sdk-runtime-behavior.test.ts` (C) | Behavioral suite importing the committed golden's TS sources (fake fetch + recorded sleep) |
| `tests/renderers/sdk-utils.test.ts` (M) | Throw tests flip to mapping tests |
| `tests/renderers/sdk-golden-helpers.ts` (M) | + `AGENT_FIXTURE_ARGS`, `renderSdkGoldenAgent` |
| `tests/renderers/sdk-fern-golden-helpers.ts` (M) | + agent fixture tree names |
| `scripts/gen-sdk-goldens.mts` (M) | + agent fixture in TS and `--langs` regen |
| `.github/workflows/sdk-docker.yml` (M) | + new paths (pagination-detect, auth/pagination plugins, agent goldens) |
| `KNOWN_GAPS.md` (M) | Records asymmetries + v1.1 deferrals |

Run all commands from the worktree root. After each task: commit (exact messages given). Tests run as `npx vitest run <file> 2>&1 | tail -5; echo "TEST_EXIT_CODE=$?"` — a non-zero exit code means failure regardless of output text.

---

### Task 1: Repair the Fern toolchain (unbreaks nightly lane; everything Fern depends on this)

**Files:**
- Modify: `src/renderers/fern-images.ts`
- Modify: `tests/renderers/fern-images.test.ts`
- Regenerate: `tests/fixtures/golden/sdk-{python,rust}-{minimal,graphql-minimal}/**` + 4 `.manifest.json`

- [ ] **Step 1: Write the failing pin tests.** In `tests/renderers/fern-images.test.ts`, ADD exact-pin assertions (the file currently asserts only shape/sync invariants, not exact versions): `FERN_PINS.cliVersion === "5.40.0"` → `"5.45.3"`; python tag `5.14.4` → `5.14.12` and its digest → `sha256:2a2eb231fcb8726abc42f9a6244b65beb9376a59ad98cc87b5853ec85b5f8a1b`; rust tag `0.36.8` → `0.40.4` and digest → `sha256:62f87e526256e9378cc844ef9084392235968239d2c6cf5bd6fee59698f3d1bb`. Keep the existing `image === name:tag` sync guard untouched.
- [ ] **Step 2: Run to verify failure.** `npx vitest run tests/renderers/fern-images.test.ts` → FAIL (old pins).
- [ ] **Step 3: Update `FERN_PINS`** in `src/renderers/fern-images.ts` to the three new versions + two new digests (tag-pinned generation unchanged; digests are recorded for verification only — preserve the existing comment saying so).
- [ ] **Step 4: Run to verify pass.** Same command → PASS. Also `npx vitest run tests/renderers/fern-project.test.ts tests/renderers/fern-docker.test.ts` → PASS (they read pins dynamically; if any hardcodes `5.40.0`, update the expectation in the same spirit).
- [ ] **Step 5: Warm new images.** `node dist/cli/index.js sdk warm` after `npm run build` (or `npx tsx src/cli/index.ts sdk warm`). Expect both pulls + `fern-api@5.45.3` prefetch to succeed.
- [ ] **Step 6: Regenerate the 4 existing Fern golden trees.** `npx tsx scripts/gen-sdk-goldens.mts --langs python,rust`. Diff will be LARGE (generator minor bumps). Review by category only (new core modules, version stamps, formatting); verify the locked invariants survive: zero `op_[0-9a-f]{6,}` leakage, snake_case methods (`def create_project` / `fn create_project`), python marker `__init__.py`, rust marker `Cargo.toml`.
- [ ] **Step 7: Run the Fern golden lock + full suite.** `npx vitest run tests/renderers/sdk-fern-golden.test.ts` → PASS. `npm test` → PASS (`TEST_EXIT_CODE=0`).
- [ ] **Step 8: Commit.** `git add -A && git commit -m "fix: bump Fern pins to CLI 5.45.3 / python 5.14.12 / rust 0.40.4 (upstream registry dropped 5.40.0 compat; unbreaks nightly lane)"`

### Task 2: Overlay schema — `auth.tokenUrl` + fixed pagination field keys

**Files:**
- Modify: `src/overlays/codegen.ts`
- Test: `tests/overlays/codegen.test.ts` (or the existing overlay test file — locate with `grep -rl "CodegenOverlaySchema" tests/`)

- [ ] **Step 1: Failing tests.** (a) `auth: { mode: "oauth2-client-credentials", tokenUrl: "https://x/oauth/token" }` parses and round-trips `tokenUrl`; (b) `pagination: { style: "cursor", fields: { requestParam: "cursor", itemsField: "data", nextField: "next_cursor" } }` parses; (c) `fields: { bogus: "x" }` is **rejected** (currently free-form record accepts it — this is the RED proof).
- [ ] **Step 2: Run → FAIL** (tokenUrl stripped; bogus accepted).
- [ ] **Step 3: Implement.** `Auth` gains `tokenUrl: z.string().url().optional()`. `Pagination.fields` becomes `z.object({ requestParam: z.string().optional(), pageSizeParam: z.string().optional(), itemsField: z.string().optional(), nextField: z.string().optional() }).strict().default({})`.
- [ ] **Step 4: Run → PASS**, plus any existing overlay tests still green.
- [ ] **Step 5: Commit.** `feat(overlay): auth.tokenUrl + fixed pagination field keys`

### Task 3: `extractAuthSchemes` stops throwing; descriptor union grows

**Files:**
- Modify: `src/renderers/sdk-utils.ts:37-62`, `src/sdk-plugins/runtime.ts:9-12` (descriptor type)
- Test: `tests/renderers/sdk-utils.test.ts`

- [ ] **Step 1: Failing tests** for the full mapping table (spec §4.1): oauth2+clientCredentials flow → `{ kind: "oauth2ClientCredentials", id, tokenUrl: "<from flow>", scopes: [...] }`; oauth2 with empty/other flows → same kind with `tokenUrl: null, scopes: []`; openIdConnect → `{ kind: "external", id, schemeType: "openIdConnect" }`; mutualTLS → external; unknown http scheme → external; existing bearer/basic/apiKey unchanged. Plus: the old "throws on oauth2" test is REMOVED (replaced by mapping assertions — never `.skip`).
- [ ] **Step 2: Run → FAIL** (current code throws).
- [ ] **Step 3: Implement.** Extend `AuthSchemeDescriptor` union in `src/sdk-plugins/runtime.ts` exactly as spec §4.1. Rewrite the throw branch in `extractAuthSchemes` into the mapping (read `flows.clientCredentials.tokenUrl` + `Object.keys(flows.clientCredentials.scopes ?? {})`). Overlay `auth.mode === "oauth2-client-credentials"` forces the oauth2 descriptor; overlay `auth.tokenUrl` fills a null tokenUrl. Explicit return type; ≤50-line functions (extract `mapSecurityScheme(id, raw): AuthSchemeDescriptor`).
- [ ] **Step 4: Run → PASS** + `npm run typecheck` → exit 0.
- [ ] **Step 5: Commit.** `feat(sdk): map oauth2/external auth schemes instead of throwing`

### Task 4: OAS renderer projects real oauth2 flows

**Files:**
- Modify: `src/renderers/oas.ts:167-193`
- Test: `tests/renderers/oas.test.ts`

- [ ] **Step 1: Failing test.** Graph with an oauth2 auth_scheme node whose `flows` claim is `{ clientCredentials: { tokenUrl: "https://api.x.test/oauth/token", scopes: {} } }` → rendered OAS securityScheme is `{ type: "oauth2", flows: <that object> }`, not `flows: {}`. Second test: no flows claim → `flows: {}` (unchanged fallback).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** in `securitySchemeFor`: read the node's `flows` claim value when present and JSON-shaped; pass through verbatim (no reshaping — provenance-preserving).
- [ ] **Step 4: Run → PASS.** Then check OAS goldens: `npx vitest run tests/renderers/oas-golden.test.ts` — existing fixtures have no oauth2 flows claims, so goldens must be byte-identical (if not, STOP and investigate).
- [ ] **Step 5: Commit.** `feat(oas): project oauth2 flows claim into securitySchemes`

### Task 5: Generated `auth.ts` module (emitter `src/sdk-plugins/auth.ts`)

**Files:**
- Create: `src/sdk-plugins/auth.ts` — `generateAuthModule(schemes: readonly AuthSchemeDescriptor[], envPrefix: string): string`
- Modify: `src/sdk-plugins/errors.ts` (emit `AuthError`, `ConfigError` classes — the existing `UnauthorizedError` at `src/sdk-plugins/errors.ts:25` is REUSED for 401-after-refresh; do NOT invent `AuthenticationError`)
- Test: `tests/sdk-plugins/auth.test.ts` (source assertions, mirror style of `tests/sdk-plugins/runtime.test.ts`)

> **Wiring deferral (Tasks 5–8):** none of Tasks 5–8 touches `src/renderers/sdk.ts`. The pipeline wiring (write `src/auth.ts`/`src/pagination.ts`, pass retries config, compute `envPrefix = slugify(productName).toUpperCase().replace(/-/g, "_")`) all happens in **Task 9** in one step, so existing TS goldens change exactly once (reviewed + re-locked there) and `npm test` stays green at every intermediate commit.

Emitted module contract (assert each via source patterns):
- `export type AuthConfig = <one member per declared scheme> | { kind: "tokenProvider"; getToken: () => Promise<string> }` — tokenProvider ALWAYS present; `external` descriptors contribute no member.
- oauth2 member: `{ kind: "oauth2"; clientId: string; clientSecret: string; tokenUrl?: string; scopes?: string[] }`; emitted token logic: POST form-encoded `grant_type=client_credentials` with HTTP Basic client auth; cache expiry `now + (expires_in ?? 300) - 60` seconds; single-flight via cached in-flight Promise; `invalidate()` for 401 handling; missing `access_token` in response → `AuthError("malformed token response")`; non-2xx token endpoint → `AuthError` with status + tokenUrl, never the secret.
- `export function resolveAuthFromEnv(): AuthConfig | null` — table from spec §4.1 with the literal `envPrefix` baked in (e.g. `ACME_TOKEN`, `ACME_API_KEY`, `ACME_USERNAME`/`ACME_PASSWORD`, `ACME_CLIENT_ID`/`ACME_CLIENT_SECRET`(+`ACME_TOKEN_URL`)), checked in OAS declaration order; returns null when nothing matches.
- `export class AuthManager` with `applyAuth(headers, searchParams): Promise<void>` + `onUnauthorized(): boolean` (invalidates cache, returns whether a one-shot refresh retry is warranted: true only for oauth2/tokenProvider, once per request).
- Construction-time behavior moves to runtime: `auth` missing → `resolveAuthFromEnv()` → still null → `throw new ConfigError(...)` whose message lists the exact accepted env var names.

- [ ] **Step 1: Failing tests** asserting all contract points above as code patterns (e.g. `expect(code).toContain('grant_type=client_credentials')`, `expect(code).toMatch(/expires_in \?\? 300/)`, env var literal names for prefix `"ACME"`).
- [ ] **Step 2: Run → FAIL** (module doesn't exist).
- [ ] **Step 3: Implement** `generateAuthModule` as pure string emission (template-literal style as the other plugins do; split helper emitters so each function ≤50 lines; emitted file must stay <300 lines — keep emitted comments terse).
- [ ] **Step 4: Errors plugin:** add `AuthError`/`ConfigError` (extend the base error class as the existing 7 do); update `tests/sdk-plugins/errors.test.ts`.
- [ ] **Step 5: Run → PASS** for both test files + typecheck.
- [ ] **Step 6: Commit.** `feat(sdk): generated auth module — oauth2 client-credentials, tokenProvider, env pickup`

### Task 6: Retry loop in generated runtime

**Files:**
- Modify: `src/sdk-plugins/runtime.ts` (signature becomes `generateRuntimeModule(schemes, retries: RetriesConfig)` where `RetriesConfig` is the overlay type with defaults applied; `src/renderers/sdk.ts` wiring deferred to Task 9)
- Test: `tests/sdk-plugins/runtime.test.ts`

Emitted contract (spec §4.2), assert as source patterns:
- `ClientOptions.sleep?: (ms: number) => Promise<void>` and a module default.
- Constants emitted from config: `MAX_RETRIES`, `RETRYABLE_STATUS` (literal array), `BASE_DELAY_MS = 500`, `MAX_DELAY_MS = 30000`.
- Loop: full-jitter backoff `random(0, min(cap, base * 2**attempt))`; `Retry-After` (integer seconds OR http-date) overrides when `honorRetryAfter`, capped at MAX_DELAY_MS; an **unparseable** `Retry-After` falls back to the computed backoff; idempotent methods (`GET|HEAD|PUT|DELETE|OPTIONS`) retry full list + network errors, and a **per-attempt timeout counts as retryable** for them; `POST|PATCH` retry only 408/429, never network errors or timeouts; fresh `Request` constructed per attempt (bodies are single-use); `onResponse` only on the final response; exhaustion rethrows final typed error with `(after N attempts)` suffix; auth 401 single-refresh retry handled via `AuthManager.onUnauthorized()` OUTSIDE the retry counter (second 401 surfaces as the existing `UnauthorizedError`); runtime imports from `./auth.js` (auth injection moves out of runtime.ts into `AuthManager.applyAuth`).
- runtime.ts emitted file stays <300 lines (auth logic has moved to auth.ts — verify with a line-count assertion in the golden test if convenient, else by inspection).

- [ ] **Step 1: Failing tests** (extend existing runtime.test.ts; keep all existing assertions that still apply; the bearer-injection assertions MOVE to auth.test.ts form).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** emission; split into `emitRequestLoop()`, `emitBackoff()` helpers ≤50 lines each.
- [ ] **Step 4: Run → PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(sdk): retry loop with jittered backoff and Retry-After in generated runtime`

### Task 7: Shared pagination detection

**Files:**
- Create: `src/renderers/pagination-detect.ts`
- Test: `tests/renderers/pagination-detect.test.ts`

API (spec §4.3, exact):

```ts
export interface PaginationPlan {
  readonly style: "cursor" | "offset" | "page";
  readonly requestParam: string;
  readonly pageSizeParam: string | null;
  readonly itemsField: string;
  readonly nextField: string | null;
}
export function detectPagination(
  ops: readonly SdkOperation[],   // from extractOperations(oasJson) — same type the other renderers use
  oasJson: string,
  overlay: CodegenOverlay,
): ReadonlyMap<string, PaginationPlan>;  // key: operationId
```

- [ ] **Step 1: Failing tests** covering: overlay perOperation override wins; overlay product-wide style+fields; auto-detect cursor (GET, 200 response object with exactly one array prop + `next_cursor` sibling + request query param `cursor`); auto-detect offset (`offset`+`limit` int params); auto-detect page (`page`+`per_page`); ambiguity → absent (two array props; no params; POST list); `nextField` null for offset/page; synonyms (`nextCursor`, `next_page_token`, `page_token`, `starting_after`, `page_size`).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** pure function over parsed OAS; helpers `autoDetectCursor`, `autoDetectOffsetOrPage`, each ≤50 lines; conservative — any doubt returns no plan.
- [ ] **Step 4: Run → PASS** + typecheck.
- [ ] **Step 5: Commit.** `feat(sdk): shared pagination detection (overlay-first, conservative auto-detect)`

### Task 8: Generated `pagination.ts` + `*Pages()` resource methods

**Files:**
- Create: `src/sdk-plugins/pagination.ts` — `generatePaginationModule(): string` (generic engine) and the per-op glue contract
- Modify: `src/sdk-plugins/resource-tree.ts` (resource emission adds `<method>Pages` when a plan exists for the op; `src/renderers/sdk.ts` wiring deferred to Task 9)
- Test: `tests/sdk-plugins/pagination.test.ts` + extend `tests/sdk-plugins/resource-tree.test.ts`

Emitted engine contract: `export async function* paginate<Item>(fetchPage: (cursorOrOffset: ...) => Promise<Response>, plan: {...literal...}): AsyncGenerator<Item>` — cursor: stop on null/missing/empty next value AND on repeated cursor (guard); offset/page: stop when page yields fewer items than requested or zero; missing itemsField → typed error naming op + field. Resource glue: `listPages(args)` delegating to plain method's request with plan literals baked in; plain methods byte-unchanged when no plans exist.

- [ ] **Step 1: Failing tests** (source assertions: generator emits the guard `if (next === prev) return;`, the three stop conditions, `*Pages` method appears in resources output only for planned ops, absent otherwise — assert the no-plan case emits resources byte-identical to before).
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS** + typecheck. The no-plan invariant is asserted at UNIT level: resource emission called with an empty plan map produces byte-identical output to the pre-change emission (snapshot the before-string in the test). Do NOT run the golden lock here — goldens regenerate once, in Task 9, after wiring.
- [ ] **Step 5: Commit.** `feat(sdk): *Pages async-generator emission for planned operations`

### Task 9: Pipeline wiring + `agent-minimal` fixture + TS golden regen (all trees) + behavioral suite

**Files:**
- Modify: `src/renderers/sdk.ts` — THE wiring step (deferred from Tasks 5–8): compute `envPrefix = slugify(productName).toUpperCase().replace(/-/g, "_")`; call `extractOperations` once, run `detectPagination(ops, oasJson, overlay)`; write generated `src/auth.ts` (always) and `src/pagination.ts` (only when plans exist); pass retries config (overlay defaults) to `generateRuntimeModule`; pass plans to resource emission. Keep `renderSdkPackage`'s function under 50 lines by extracting private helpers.
- Create: `tests/fixtures/openapi3/agent-minimal.yaml` — single spec file per repo convention (model on `tests/fixtures/openapi3/minimal.yaml`): oauth2 clientCredentials scheme (tokenUrl `https://api.agentmin.test/oauth/token`) + `POST /oauth/token` op + `GET /items` cursor-paginated (params `cursor`,`limit`; response `{data: [...], next_cursor}`) + `GET /logs` offset-paginated (`offset`,`limit`) + `POST /items` plain. **productName MUST be exactly `agentmin`** (slugifies to `agentmin` → env prefix `AGENTMIN_`; a dotted name would yield `AGENTMIN_TEST_` and break the env assertions).
- Modify: `tests/renderers/sdk-golden-helpers.ts` (add `AGENT_FIXTURE_ARGS` + `renderSdkGoldenAgent(outDir)` following `REST_FIXTURE_ARGS` shape), `scripts/gen-sdk-goldens.mts` (include agent fixture), `tests/renderers/sdk-golden.test.ts` (third tree in lock + tsc gate)
- Create: `tests/fixtures/golden/sdk-agent-minimal/**` (generated, committed); regenerate `tests/fixtures/golden/sdk-minimal/**` and `sdk-graphql-minimal/**` (they gain `src/auth.ts` + changed `runtime.ts`/`errors.ts`)
- Create: `tests/renderers/sdk-runtime-behavior.test.ts`

- [ ] **Step 1: Wire `src/renderers/sdk.ts`** (failing state: golden lock goes RED because fresh renders now differ from committed trees — that is the expected RED for this task).
- [ ] **Step 2: Build the fixture + helpers** (`AGENT_FIXTURE_ARGS`, `renderSdkGoldenAgent`, script + lock-test wiring).
- [ ] **Step 3: Regenerate ALL THREE TS trees.** `npx tsx scripts/gen-sdk-goldens.mts`. Review by category: existing two trees gain `src/auth.ts` (bearer member + tokenProvider + env pickup) and a retry-loop `runtime.ts`, NO `pagination.ts` (no plans); agent tree additionally has `src/pagination.ts`, `itemsPages`/`logsPages` in resources, oauth2 AuthConfig member. Verify every emitted file <300 lines.
- [ ] **Step 4: Lock + gates.** Golden lock (3 trees) + `tsc --noEmit` on all three → PASS.
- [ ] **Step 5: Behavioral suite** — `tests/renderers/sdk-runtime-behavior.test.ts` imports DIRECTLY from the committed golden sources (import the `.ts` modules, e.g. `../fixtures/golden/sdk-agent-minimal/src/runtime.js` via vitest's TS resolution of `.js` specifiers; if specifier resolution fights, import `runtime.ts`/`auth.ts`/`pagination.ts` paths directly). Tests (all with injected fake `fetch` and recorded `sleep`, zero real timers):
  1. oauth2: first API call POSTs tokenUrl once (Basic header, form body), Authorization Bearer on API call; second call reuses cache (token endpoint hit exactly once).
  2. single-flight: two concurrent calls → one token fetch.
  3. 401 → cache invalidated → token re-fetched → request retried once → success; second 401 → `UnauthorizedError` (the existing emitted class — NOT a new `AuthenticationError`).
  4. env pickup: `AGENTMIN_CLIENT_ID`/`AGENTMIN_CLIENT_SECRET` set (use `vi.stubEnv`), no `auth` option → works; nothing set → ConfigError message contains `AGENTMIN_CLIENT_ID`.
  5. 429 with `Retry-After: 1` → recorded sleep `[1000]` → attempt 2 succeeds; 429 with `Retry-After: garbage` → computed-backoff sleep within jitter bounds (fallback verified).
  6. GET 500,500,200 → two backoff sleeps each within `[0, min(30000, 500·2^n)]` → success; POST 500 → immediate throw, zero sleeps; GET per-attempt timeout → retried (idempotent-timeout rule).
  7. `itemsPages()`: 3 pages then `next_cursor: null` → yields all items, fetch called 3×; repeated-cursor page → iteration stops, no hang (use a timeout guard).
  8. tokenProvider: `getToken` called, Bearer applied.
- [ ] **Step 6: Run everything.** behavior suite + golden lock + `npm test` → `TEST_EXIT_CODE=0`. Any behavioral failure = fix the EMITTER (Tasks 5–8 code), regenerate goldens, re-lock — never hand-edit a golden.
- [ ] **Step 7: Commit.** `feat(sdk): wire auth/retries/pagination into pipeline; agent fixture, regenerated goldens, behavioral suite`

Note: the README env table is NOT yet present in these trees — it arrives in Task 10, which regenerates and re-locks again. Do not assert README content in this task.

### Task 10: README template — auth + pagination documentation

**Files:**
- Modify: `src/renderers/sdk-templates/README.md.tpl` (locate actual template path via `grep -r "README" src/renderers/sdk*.ts`), template renderer in `src/renderers/sdk.ts`
- Test: extend `tests/renderers/sdk-templates.test.ts`

- [ ] **Step 1: Failing tests:** rendered README contains the env-var table for the product's declared schemes (exact names), an oauth2 quickstart snippet, a tokenProvider snippet when any `external` scheme exists, and a `*Pages()` example when any pagination plan exists.
- [ ] **Step 2–4:** RED → implement template sections (conditional blocks consistent with existing template engine) → GREEN; regenerate agent golden (README changes) → re-lock; existing goldens: bearer-only fixtures gain the env table too (expected — review + re-lock both existing TS trees).
- [ ] **Step 5: Commit.** `feat(sdk): README documents env vars, oauth2, tokenProvider, pagination`

### Task 11: Fern translation — auth-schemes OAuth + x-fern-pagination stamping

**Files:**
- Modify: `src/renderers/fern-project.ts` (signature: `buildFernProject(langs, opts: { oauth: FernOAuthPlan | null })`), `src/renderers/fern-oas-rewrite.ts` (stamp extensions), `src/renderers/sdk-fern.ts` (compute + thread both)
- Test: `tests/renderers/fern-project.test.ts`, `tests/renderers/fern-oas-rewrite.test.ts`

`FernOAuthPlan` = `{ tokenEndpoint: "POST /oauth/token", requestProps: {...}, responseProps: {...} }`, computed ONLY when: an `oauth2ClientCredentials` descriptor exists AND the token endpoint operation is present in the synthetic OAS (match the descriptor's `tokenUrl` path against the OAS server URL + paths) AND the token URL host equals the API host. Otherwise null → no `auth-schemes` block (Fern falls back to its default bearer mapping) + README snippet path.

- [ ] **Step 1: Failing tests.** fern-project: with a plan → generators.yml contains the verified S1 block exactly (auth-schemes + `api.auth: OAuth` + `$request.`/`$response.` prefixed properties, endpoint string `POST /oauth/token`); with null → no auth-schemes key (byte-stable vs today modulo pin bump). fern-oas-rewrite: ops with cursor plans gain `"x-fern-pagination": { cursor: "$request.<requestParam>", next_cursor: "$response.<nextField>", results: "$response.<itemsField>" }`; offset plans gain `{ offset: "$request.<requestParam>", results: "$response.<itemsField>" }`; page style: stamp the offset form with the page param (Fern has no distinct page type at this syntax level — record in KNOWN_GAPS); unplanned ops byte-unchanged; input never mutated.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both (pure functions; detection reuses `detectPagination` output passed in — do NOT re-detect inside Fern code).
- [ ] **Step 4: Run → PASS** + typecheck + existing fern tests green.
- [ ] **Step 5: S2 verdict is final (see spike section): no pager recipe exists.** Stamping stays (forward-compatible); make no claims of Python/Rust pager support anywhere (READMEs, docs).
- [ ] **Step 6: Commit.** `feat(fern): conditional OAuth auth-schemes + x-fern-pagination stamping from shared plans`

### Task 12: Fern goldens for the agent fixture

**Files:**
- Modify: `tests/renderers/sdk-fern-golden-helpers.ts` (`fernTreeName` + agent fixture), `scripts/gen-sdk-goldens.mts` (agent fixture in `--langs` path), `tests/renderers/sdk-fern-golden.test.ts` (2 new trees in TREES)
- Create: `tests/fixtures/golden/sdk-python-agent-minimal/**`, `tests/fixtures/golden/sdk-rust-agent-minimal/**` + manifests

- [ ] **Step 1: Wire helpers + failing lock** (trees absent → RED).
- [ ] **Step 2: Generate.** `npx tsx scripts/gen-sdk-goldens.mts --langs python,rust` (Docker). Verify structurally: rust tree contains `src/core/oauth_token_provider.rs` and builder `oauth_credentials`; python tree builds with `token` callable param (no oauth wiring — expected per S1); zero op-hash leakage; snake_case methods.
- [ ] **Step 3: Add structural assertions** to `sdk-fern-golden.test.ts`: rust agent tree MUST contain `oauth_token_provider.rs` (regression guard on the auth-schemes wiring); both manifests verify.
- [ ] **Step 4: Full suite** `npm test` → exit 0.
- [ ] **Step 5: Commit.** `test(fern): python/rust agent-fixture goldens with OAuth wiring locked`

### Task 13: CI paths, KNOWN_GAPS, docs, final sweep

**Files:**
- Modify: `.github/workflows/sdk-docker.yml` (paths: + `src/renderers/pagination-detect.ts`, `src/sdk-plugins/auth.ts`, `src/sdk-plugins/pagination.ts`, agent golden paths), `KNOWN_GAPS.md`, `docs/ARCHITECTURE.md` (renderer list), `README.md` (feature bullets if present)

- [ ] **Step 1: CI updates** (the workflow is nightly `schedule` + `pull_request` — there is NO push trigger; do not add one):
  - `pull_request.paths`: add `src/renderers/pagination-detect.ts`, `src/sdk-plugins/auth.ts`, `src/sdk-plugins/pagination.ts`, and the agent golden tree paths.
  - The **byte-diff step** hardcodes the four existing tree dirs — add `sdk-python-agent-minimal` and `sdk-rust-agent-minimal` to that list.
  - The **cargo-check loop** and the **compileall loop** hardcode tree names — add the agent trees to both, otherwise the new trees are never compile-gated (success criterion 5 would silently fail).
  - The regen step itself needs no change (Task 12 already extended `scripts/gen-sdk-goldens.mts`).
- [ ] **Step 2: KNOWN_GAPS.md** — new section "Agent-ready SDK runtime (2026-06-10)": python OAuth not generator-wired (token callable + README snippet); env pickup TS-only; rust retry default 3 vs overlay 2; pagination pager emission status per S2 verdict; page-style stamped as offset for Fern; v1.1 deferrals (device flow, token cache on disk, streaming, webhooks, idempotency auto-injection).
- [ ] **Step 3: Docs sweep** — ARCHITECTURE renderer list + spec status update (Approved → Implemented).
- [ ] **Step 4: Full verification.** `npm run typecheck && npm test && npm run build; echo EXIT=$?` → all 0. Confirm existing golden byte-stability where promised (Tasks 4, 8).
- [ ] **Step 5: Commit.** `docs+ci: agent-ready SDK runtime gaps, paths, architecture notes`
