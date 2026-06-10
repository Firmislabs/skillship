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
- **Plan consequence:** Task 10 stamps `x-fern-pagination` from the shared plans (verified harmless at generation; auto-activates pagers on regen if Fern ever lifts the gates), Task 12 records "pagination helpers: TypeScript only; Python/Rust expose plain list methods with cursor/offset params" in KNOWN_GAPS.md and the Fern-side READMEs are not modified (Fern owns them).

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
| `tests/renderers/sdk-utils.test.ts` (C) | New file: descriptor mapping table tests |
| `tests/renderers/sdk.test.ts` (M) | Render-level oauth2 throw test → renders-successfully test |
| `src/extractors/openapi3.ts` (M) | `pushAuthClaims` emits oauth2 `flows` claim |
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
- Modify: `tests/renderers/sdk.test.ts:176-201` — the existing "throws on oauth2" coverage lives HERE (render-level), not in a sdk-utils test file
- Test: Create `tests/renderers/sdk-utils.test.ts` (new file) for the mapping table

- [ ] **Step 1: Failing tests** for the full mapping table (spec §4.1): oauth2+clientCredentials flow → `{ kind: "oauth2ClientCredentials", id, tokenUrl: "<from flow>", scopes: [...] }`; oauth2 with empty/other flows → same kind with `tokenUrl: null, scopes: []`; openIdConnect → `{ kind: "external", id, schemeType: "openIdConnect" }`; mutualTLS → external; unknown http scheme → external; existing bearer/basic/apiKey unchanged. In the SAME commit, REPLACE the render-level throw test in `tests/renderers/sdk.test.ts:176-201`: an oauth2-only spec now renders SUCCESSFULLY, and its interim `AuthConfig` falls back to the existing `{ readonly kind: "none" }` sentinel (oauth2/external kinds are no-op until Task 8) — never `.skip`, never leave it red.
- [ ] **Step 2: Run → FAIL** (current code throws).
- [ ] **Step 3: Implement.** Extend `AuthSchemeDescriptor` union in `src/sdk-plugins/runtime.ts` exactly as spec §4.1. Rewrite the throw branch in `extractAuthSchemes` into the mapping (read `flows.clientCredentials.tokenUrl` + `Object.keys(flows.clientCredentials.scopes ?? {})`). Overlay `auth.mode === "oauth2-client-credentials"` forces the oauth2 descriptor; overlay `auth.tokenUrl` fills a null tokenUrl. Explicit return type; ≤50-line functions (extract `mapSecurityScheme(id, raw): AuthSchemeDescriptor`). **Golden-lock safety:** where the runtime emitter switches over descriptor kinds (`buildAuthUnion`/`buildInjectBody` at `src/sdk-plugins/runtime.ts:105-140` — kind-equality ifs, not exhaustive switches), the NEW kinds get no-op branches in this task — they contribute NOTHING to emitted output until Task 8. **Interim invariant:** when descriptors contain ONLY new kinds, `buildAuthUnion` must fall back to the existing `{ readonly kind: "none" }` sentinel (an empty join would emit `export type AuthConfig = ;` — a tsc-gate failure). Existing fixtures are bearer-only, so rendered output is unchanged and the golden lock stays green; verify with `npx vitest run tests/renderers/sdk-golden.test.ts`, and `npm test` must be exit 0 at this commit.
- [ ] **Step 4: Run → PASS** + `npm run typecheck` → exit 0.
- [ ] **Step 5: Commit.** `feat(sdk): map oauth2/external auth schemes instead of throwing`

### Task 4: oauth2 flows — extractor ingestion + OAS renderer projection

**The full chain must work end-to-end** (review round 3 finding): the `AuthSchemeNode` TYPE has a `flows` field, but `pushAuthClaims` in `src/extractors/openapi3.ts:167-198` never emits a `flows` claim (only the mcpWellKnown extractor does). Without ingestion, Task 8's behavioral tests and Tasks 10–11's Fern OAuth plan would silently get `tokenUrl: null`. This task closes BOTH ends.

**Files:**
- Modify: `src/extractors/openapi3.ts:167-198` (`pushAuthClaims` emits the oauth2 `flows` object as a claim, verbatim, when the securityScheme has one)
- Modify: `src/renderers/oas.ts:167-193`
- Test: `tests/extractors/openapi3.test.ts` (or wherever pushAuthClaims is covered — `grep -rl "securitySchemes" tests/extractors/`), `tests/renderers/oas.test.ts`

- [ ] **Step 1: Failing extractor test.** Ingesting a spec whose oauth2 scheme declares `flows.clientCredentials.tokenUrl` produces an auth_scheme node with a `flows` claim carrying that object verbatim (source provenance, same confidence tier as the sibling `type` claim).
- [ ] **Step 2: Run → FAIL** (no flows claim emitted today).
- [ ] **Step 3: Implement** in `pushAuthClaims`: when `raw.type === "oauth2"` and `raw.flows` is an object, emit a `flows` claim (JSON value passthrough — provenance-preserving, no reshaping).
- [ ] **Step 4: Failing renderer test.** Graph with an oauth2 auth_scheme node whose `flows` claim is `{ clientCredentials: { tokenUrl: "https://api.x.test/oauth/token", scopes: {} } }` → rendered OAS securityScheme is `{ type: "oauth2", flows: <that object> }`, not `flows: {}`. Second test: no flows claim → `flows: {}` (unchanged fallback).
- [ ] **Step 5: Run → FAIL, implement** in `securitySchemeFor` (read the claim when present and JSON-shaped; pass through verbatim), **run → PASS.**
- [ ] **Step 6: Golden stability.** `npx vitest run tests/renderers/oas-golden.test.ts` — existing fixtures have no oauth2 schemes, so OAS goldens must be byte-identical (if not, STOP and investigate). Full `npm test` → exit 0.
- [ ] **Step 7: Commit.** `feat(oas): ingest + project oauth2 flows end-to-end (extractor claim → securitySchemes)`

### Task 5: Generated `auth.ts` module (emitter `src/sdk-plugins/auth.ts`)

**Files:**
- Create: `src/sdk-plugins/auth.ts` — `generateAuthModule(schemes: readonly AuthSchemeDescriptor[], envPrefix: string): string`
- Test: `tests/sdk-plugins/auth.test.ts` (source assertions, mirror style of `tests/sdk-plugins/runtime.test.ts`)

> **Golden-lock discipline (Tasks 5–7):** `tests/renderers/sdk-golden.test.ts` re-renders with the LIVE emitters, so any change that alters rendered output for existing fixtures reds the suite. Tasks 5–7 therefore make only changes that are invisible to existing renders: Task 5 creates a NEW unwired module; Task 6 creates a NEW module; Task 7 adds an OPTIONAL parameter whose absence produces byte-identical output. Everything that changes rendered output (runtime retry loop, errors additions, `src/renderers/sdk.ts` wiring) lands together in **Task 8** with the single reviewed golden regeneration. Do NOT touch `src/sdk-plugins/errors.ts` or `src/sdk-plugins/runtime.ts`'s emitted output before Task 8.

Emitted module contract (assert each via source patterns):
- `export type AuthConfig = <one member per declared scheme> | { kind: "tokenProvider"; getToken: () => Promise<string> }` — tokenProvider ALWAYS present; `external` descriptors contribute no member.
- oauth2 member: `{ kind: "oauth2"; clientId: string; clientSecret: string; tokenUrl?: string; scopes?: string[] }`; emitted token logic: POST form-encoded `grant_type=client_credentials` with HTTP Basic client auth, **performed via the fetch implementation passed into `AuthManager` by the client (the injected `opts.fetch`), never `globalThis.fetch` directly** — behavioral tests depend on this; cache expiry `now + (expires_in ?? 300) - 60` seconds; single-flight via cached in-flight Promise; `invalidate()` for 401 handling; missing `access_token` in response → `AuthError("malformed token response")`; non-2xx token endpoint → `AuthError` with status + tokenUrl, never the secret.
- `export function resolveAuthFromEnv(): AuthConfig | null` — table from spec §4.1 with the literal `envPrefix` baked in (e.g. `ACME_TOKEN`, `ACME_API_KEY`, `ACME_USERNAME`/`ACME_PASSWORD`, `ACME_CLIENT_ID`/`ACME_CLIENT_SECRET`(+`ACME_TOKEN_URL`)), checked in OAS declaration order; returns null when nothing matches.
- `export class AuthManager` with `applyAuth(headers, searchParams): Promise<void>` + `onUnauthorized(): boolean` (invalidates cache, returns whether a one-shot refresh retry is warranted: true only for oauth2/tokenProvider, once per request).
- The module references `AuthError`/`ConfigError` from `./errors.js` — those classes are EMITTED in Task 8 (errors plugin change); Task 5's module is unwired and nothing compiles it yet, so the forward reference is safe.

- [ ] **Step 1: Failing tests** asserting all contract points above as code patterns (e.g. `expect(code).toContain('grant_type=client_credentials')`, `expect(code).toMatch(/expires_in \?\? 300/)`, env var literal names for prefix `"ACME"`).
- [ ] **Step 2: Run → FAIL** (module doesn't exist).
- [ ] **Step 3: Implement** `generateAuthModule` as pure string emission (template-literal style as the other plugins do; split helper emitters so each function ≤50 lines; emitted file must stay <300 lines — keep emitted comments terse).
- [ ] **Step 4: Run → PASS** for the new test file + typecheck + `npx vitest run tests/renderers/sdk-golden.test.ts` (must still pass — nothing rendered changed).
- [ ] **Step 5: Commit.** `feat(sdk): generated auth module emitter — oauth2 client-credentials, tokenProvider, env pickup`

### Task 6: Shared pagination detection

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

### Task 6b: Inline response-schema passthrough (prerequisite discovered by Task 6 review)

**Why (verified):** the synthetic OAS never carries response-schema `properties` — `pushResponseClaims` (`src/extractors/openapi3-ops.ts` ~line 314) persists only a `schema_ref` claim (and only for `$ref` schemas; inline schemas produce nothing), and `buildResponses` (`src/renderers/oas.ts:160`) emits `$ref`-to-stub or bare `{ type: "object" }`. Without this task, pagination tiers 2–3 are dead code in the real pipeline and Task 8's fixture expectations fail.

**Scope decision:** inline schemas ONLY. When an operation's JSON response schema is an INLINE object (not `$ref`), persist it verbatim as a `schema_json` claim and project it verbatim in `buildResponses`. `$ref` schemas keep today's stub behavior (component-schema preservation is future work — Task 12 records it in KNOWN_GAPS; detection not firing for `$ref` specs is an acceptable false negative under the conservatism contract). Existing fixtures are `$ref`-style → OAS goldens and TS goldens stay BYTE-IDENTICAL (verify — that is the golden-lock proof this task is safe).

**Files:**
- Modify: `src/extractors/openapi3-ops.ts` (`pushResponseClaims`: inline-object schema → `schema_json` claim, verbatim JSON, attested confidence, span_path consistent with siblings)
- Modify: `src/renderers/oas.ts` (`buildResponses`: when a `schema_json` claim exists and parses to an object, emit it verbatim as the response schema; precedence below `schema_ref`)
- Test: `tests/extractors/` (wherever pushResponseClaims is covered) + `tests/renderers/oas.test.ts`
- Cleanups from Task 6 quality review (same commit, `src/renderers/pagination-detect.ts`): remove the dead `oasJson.trim() === "{}"` ternary; collapse `planFromOverlayStyle`'s copy-paste branches via a `STYLE_DEFAULTS` lookup; hoist the duplicated exactly-one-array-prop computation out of the two auto-detect helpers. Split `tests/renderers/pagination-detect.test.ts` (651 lines) into `pagination-detect-overlay.test.ts` + `pagination-detect-auto.test.ts` sharing builders via a non-test helper module (house 300-line rule).

- [ ] **Step 1: Failing extractor test** — ingesting a spec with an INLINE 200 response schema (object with `data` array + `next_cursor`) produces a `schema_json` claim carrying it verbatim; `$ref` responses still produce `schema_ref` only.
- [ ] **Step 2: RED → implement extractor → GREEN.**
- [ ] **Step 3: Failing renderer test** — graph with a `schema_json` claim → synthetic OAS response carries the schema verbatim; without it → stub (unchanged); with both `schema_ref` and `schema_json` → ref wins.
- [ ] **Step 4: RED → implement renderer → GREEN.**
- [ ] **Step 5: End-to-end pin** — one test: ingest inline-schema spec → render synthetic OAS → `detectPagination` (real modules, no hand-built OAS) returns a cursor plan for the list op. This is the test C1 said was missing.
- [ ] **Step 6: Byte-stability proof.** `set -o pipefail; npx vitest run tests/renderers/oas-golden.test.ts tests/renderers/sdk-golden.test.ts 2>&1 | tail -3; echo EXIT=$?` → 0, byte-identical (existing fixtures are `$ref`-style). If NOT byte-identical, STOP — report BLOCKED.
- [ ] **Step 7: Cleanups + test split** (listed above), suite green, typecheck 0.
- [ ] **Step 8: Commit.** `feat(oas): inline response-schema passthrough (schema_json claim) + pagination-detect cleanups`

### Task 7: Generated `pagination.ts` + `*Pages()` resource methods

**Files:**
- Create: `src/sdk-plugins/pagination.ts` — `generatePaginationModule(): string` (generic engine) and the per-op glue contract
- Modify: `src/sdk-plugins/resource-tree.ts` (resource emission adds `<method>Pages` when a plan exists for the op)
- Test: `tests/sdk-plugins/pagination.test.ts` + extend `tests/sdk-plugins/resource-tree.test.ts`

**Compile-safety requirements (verified necessary by review):** the plans parameter on `generateResourceTreeModule` is OPTIONAL, defaulting to an empty map (`plans: ReadonlyMap<string, PaginationPlan> = new Map()`), so the untouched call site at `src/renderers/sdk.ts:151-155` keeps compiling and rendering byte-identically until Task 8 wires it. The emitted `import ... from "./pagination.js"` line appears in resources output ONLY when at least one plan exists — otherwise the no-plan fixtures' tsc gate would fail on a missing module.

Emitted engine contract: `export async function* paginate<Item>(fetchPage: (cursorOrOffset: ...) => Promise<Response>, plan: {...literal...}): AsyncGenerator<Item>` — cursor: stop on null/missing/empty next value AND on repeated cursor (guard); offset/page: stop when page yields fewer items than requested or zero; missing itemsField → typed error naming op + field. Resource glue: `listPages(args)` delegating to plain method's request with plan literals baked in; plain methods byte-unchanged when no plans exist.

- [ ] **Step 1: Failing tests** (source assertions: the repeated-cursor guard, the three stop conditions, `*Pages` method + the `./pagination.js` import appear in resources output only for planned ops, absent otherwise — assert the no-plan case emits resources byte-identical to before). **CORRECTION (executed form):** the originally-planned guard literal `if (next === prev) return;` was itself an off-by-one — the implemented guard is `if (next === cursor) return;` (compare against the cursor that produced the response), page-style counters start at 1 (page/per_page convention is 1-based), and the engine's offset/page stop takes an explicit `requestedPageSize` third parameter threaded from user query opts. Engine behavior is covered by runtime tests that transpile and EXECUTE the emission with exact fetch-call-count assertions — do not revert to source-pattern-only testing.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run → PASS** + typecheck + `npx vitest run tests/renderers/sdk-golden.test.ts` (must still pass — empty-plan default renders byte-identically).
- [ ] **Step 5: Commit.** `feat(sdk): *Pages async-generator emission for planned operations`

### Task 8: Runtime retry emission + errors + pipeline wiring + `agent-minimal` fixture + TS golden regen (all trees) + behavioral suite

This is the deliberate "big-bang" task: every change that alters rendered output for existing fixtures lands here, in ONE commit, with ONE reviewed golden regeneration. (Review round 2 established that splitting these reds the golden lock and `tests/renderers/sdk.test.ts` mid-sequence: the rendered `runtime.ts` imports `./auth.js`, which only exists once sdk.ts writes it.)

**Files:**
- Modify: `src/sdk-plugins/runtime.ts` — signature becomes `generateRuntimeModule(schemes, retries?: RetriesConfig)` (optional with defaults so older call sites compile during the task); retry-loop emission per the contract below; auth injection moves out into `AuthManager.applyAuth` (runtime imports `./auth.js`).
- Modify: `src/sdk-plugins/errors.ts` — add emitted `AuthError`, `ConfigError` (extend the base error class as the existing 7 do). The existing `UnauthorizedError` at `src/sdk-plugins/errors.ts:25` is REUSED for 401-after-refresh; do NOT invent `AuthenticationError`.
- Modify: `src/renderers/sdk.ts` — THE wiring step: compute `envPrefix = slugify(productName).toUpperCase().replace(/-/g, "_")`; **pass the overlay to auth extraction: `extractAuthSchemes(input.oasJson, input.overlay)` at sdk.ts:78 (Task 3 added the param but the call site is deliberately unwired until now — without this the overlay forcing/tokenUrl feature is dead code)**; call `extractOperations` once, run `detectPagination(ops, oasJson, overlay)`; write generated `src/auth.ts` (always) and `src/pagination.ts` (only when plans exist); pass retries config (overlay defaults) to `generateRuntimeModule`; pass plans to resource emission. Keep every function under 50 lines by extracting private helpers. Unit-test additions while here (Task 3 review follow-ups): `generateRuntimeModule` with only-new-kind descriptors → sentinel union + inert body; mixed `[bearer, oauth2]` descriptors → both members emitted (post-Task-8 semantics); one multi-scheme overlay-forcing test locking product-wide semantics.
- Create: `tests/fixtures/openapi3/agent-minimal.yaml` — single spec file per repo convention (model on `tests/fixtures/openapi3/minimal.yaml`): oauth2 clientCredentials scheme (tokenUrl `https://api.agentmin.test/oauth/token`) + `POST /oauth/token` op + `GET /items` cursor-paginated (params `cursor`,`limit`; response `{data: [...], next_cursor}`) + `GET /logs` offset-paginated (`offset`,`limit`) + `POST /items` plain. **Security wiring is mandatory:** document-level `security: [{<oauth2SchemeId>: []}]` so every operation inherits `auth_requires` edges (the extractor inherits top-level security, `openapi3-ops.ts:430-444`), with `security: []` on `POST /oauth/token` to opt the token endpoint out — without this, `buildSecurity` emits zero securitySchemes and the whole chain is silently authless. **productName MUST be exactly `agentmin`** (slugifies to `agentmin` → env prefix `AGENTMIN_`; a dotted name would yield `AGENTMIN_TEST_` and break the env assertions).
- Modify: `tests/sdk-plugins/runtime.test.ts` (retry contract assertions; bearer-injection assertions move to auth-module form), `tests/sdk-plugins/errors.test.ts` (AuthError/ConfigError), `tests/renderers/sdk-golden-helpers.ts` (add `AGENT_FIXTURE_ARGS` + `renderSdkGoldenAgent(outDir)` following `REST_FIXTURE_ARGS` shape), `scripts/gen-sdk-goldens.mts` (include agent fixture), `tests/renderers/sdk-golden.test.ts` (third tree in lock + tsc gate)
- Create: `tests/fixtures/golden/sdk-agent-minimal/**` (generated, committed); regenerate `tests/fixtures/golden/sdk-minimal/**` and `sdk-graphql-minimal/**` (they gain `src/auth.ts` + changed `runtime.ts`/`errors.ts`)
- Create: `tests/renderers/sdk-runtime-behavior.test.ts`

Runtime emitted contract (spec §4.2), assert as source patterns in `tests/sdk-plugins/runtime.test.ts`:
- `ClientOptions.sleep?: (ms: number) => Promise<void>` and a module default.
- Constants emitted from config: `MAX_RETRIES`, `RETRYABLE_STATUS` (literal array), `BASE_DELAY_MS = 500`, `MAX_DELAY_MS = 30000`.
- Loop: full-jitter backoff `random(0, min(cap, base * 2**attempt))`; `Retry-After` (integer seconds OR http-date) overrides when `honorRetryAfter`, capped at MAX_DELAY_MS; an **unparseable** `Retry-After` falls back to the computed backoff; idempotent methods (`GET|HEAD|PUT|DELETE|OPTIONS`) retry full list + network errors, and a **per-attempt timeout counts as retryable** for them; `POST|PATCH` retry only 408/429, never network errors or timeouts; fresh `Request` constructed per attempt (bodies are single-use); `onResponse` only on the final response; exhaustion rethrows final typed error with `(after N attempts)` suffix; auth 401 single-refresh retry handled via `AuthManager.onUnauthorized()` OUTSIDE the retry counter (second 401 surfaces as the existing `UnauthorizedError`).
- Emitted `runtime.ts` stays <300 lines (auth logic lives in auth.ts); split emitter helpers (`emitRequestLoop()`, `emitBackoff()`) ≤50 lines each.

- [ ] **Step 1: Failing unit tests first.** Write the runtime retry-contract assertions + AuthError/ConfigError errors-plugin tests. Run → FAIL (RED).
- [ ] **Step 2: Implement the emitters** (runtime.ts retry loop + auth delegation; errors.ts additions). Unit tests → PASS. The golden lock and `tests/renderers/sdk.test.ts` are now RED — expected and confined to this task; do not commit yet.
- [ ] **Step 3: Wire `src/renderers/sdk.ts`** (all wiring bullets above).
- [ ] **Step 4: Build the fixture + helpers** (`AGENT_FIXTURE_ARGS`, `renderSdkGoldenAgent`, script + lock-test wiring).
- [ ] **Step 5: Regenerate ALL THREE TS trees.** `npx tsx scripts/gen-sdk-goldens.mts`. Review by category: existing two trees gain `src/auth.ts` (bearer member + tokenProvider + env pickup) and a retry-loop `runtime.ts` + extended `errors.ts`, NO `pagination.ts` (no plans); agent tree additionally has `src/pagination.ts`, `itemsPages`/`logsPages` in resources, oauth2 AuthConfig member. Verify every emitted file <300 lines.
- [ ] **Step 6: Lock + gates.** Golden lock (3 trees) + `tsc --noEmit` on all three → PASS.
- [ ] **Step 7: Behavioral suite** — `tests/renderers/sdk-runtime-behavior.test.ts` imports DIRECTLY from the committed golden sources (import the `.ts` modules, e.g. `../fixtures/golden/sdk-agent-minimal/src/runtime.js` via vitest's TS resolution of `.js` specifiers; if specifier resolution fights, import `runtime.ts`/`auth.ts`/`pagination.ts` paths directly). Tests (all with injected fake `fetch` and recorded `sleep`, zero real timers):
  1. oauth2: first API call POSTs tokenUrl once (Basic header, form body), Authorization Bearer on API call; second call reuses cache (token endpoint hit exactly once).
  2. single-flight: two concurrent calls → one token fetch.
  3. 401 → cache invalidated → token re-fetched → request retried once → success; second 401 → `UnauthorizedError` (the existing emitted class — NOT a new `AuthenticationError`).
  4. env pickup: `AGENTMIN_CLIENT_ID`/`AGENTMIN_CLIENT_SECRET` set (use `vi.stubEnv`), no `auth` option → works; nothing set → ConfigError message contains `AGENTMIN_CLIENT_ID`.
  5. 429 with `Retry-After: 1` → recorded sleep `[1000]` → attempt 2 succeeds; 429 with `Retry-After: garbage` → computed-backoff sleep within jitter bounds (fallback verified).
  6. GET 500,500,200 → two backoff sleeps each within `[0, min(30000, 500·2^n)]` → success; POST 500 → immediate throw, zero sleeps; GET per-attempt timeout → retried (idempotent-timeout rule).
  7. `itemsPages()`: 3 pages then `next_cursor: null` → yields all items, fetch called 3×; repeated-cursor page → iteration stops, no hang (use a timeout guard).
  8. tokenProvider: `getToken` called, Bearer applied.
- [ ] **Step 8: Run everything.** behavior suite + golden lock + `npm test` → `TEST_EXIT_CODE=0`. Any behavioral failure = fix the EMITTER (Tasks 5/7/8 code), regenerate goldens, re-lock — never hand-edit a golden.
- [ ] **Step 9: Commit.** `feat(sdk): retry loop + auth wiring + agent fixture, regenerated goldens, behavioral suite`

Note: the README env table is NOT yet present in these trees — it arrives in Task 9, which regenerates and re-locks again. Do not assert README content in this task.

### Task 9: README template — auth + pagination documentation

**Files:**
- Modify: `src/renderers/sdk-templates/README.md.tpl` (locate actual template path via `grep -r "README" src/renderers/sdk*.ts`), template renderer in `src/renderers/sdk.ts`
- Test: extend `tests/renderers/sdk-templates.test.ts`

- [ ] **Step 1: Failing tests:** rendered README contains the env-var table for the product's declared schemes (exact names), an oauth2 quickstart snippet, a tokenProvider snippet when any `external` scheme exists, and a `*Pages()` example when any pagination plan exists.
- [ ] **Step 2–4:** RED → implement template sections (conditional blocks consistent with existing template engine) → GREEN; regenerate agent golden (README changes) → re-lock; existing goldens: bearer-only fixtures gain the env table too (expected — review + re-lock both existing TS trees).
- [ ] **Step 5: Commit.** `feat(sdk): README documents env vars, oauth2, tokenProvider, pagination`

### Task 10: Fern translation — auth-schemes OAuth + x-fern-pagination stamping

**Files:**
- Modify: `src/renderers/fern-project.ts` (signature: `buildFernProject(langs, opts: { oauth: FernOAuthPlan | null })`), `src/renderers/fern-oas-rewrite.ts` (stamp extensions), `src/renderers/sdk-fern.ts` (compute + thread both)
- Test: `tests/renderers/fern-project.test.ts`, `tests/renderers/fern-oas-rewrite.test.ts`

`FernOAuthPlan` = `{ tokenEndpoint: "POST /oauth/token", requestProps: {...}, responseProps: {...} }`, computed ONLY when: an `oauth2ClientCredentials` descriptor exists with a non-null `tokenUrl` AND the tokenUrl's **path** matches an OAS path that has a POST operation (path-presence gate ONLY — the synthetic OAS has no `servers` block, so host comparison is unevaluable; do not attempt it). Otherwise null → no `auth-schemes` block (Fern falls back to its default bearer mapping) + README snippet path.

- [ ] **Step 1: Failing tests.** fern-project: with a plan → generators.yml contains the verified S1 block exactly (auth-schemes + `api.auth: OAuth` + `$request.`/`$response.` prefixed properties, endpoint string `POST /oauth/token`); with null → no auth-schemes key (byte-stable vs today modulo pin bump). fern-oas-rewrite: ops with cursor plans gain `"x-fern-pagination": { cursor: "$request.<requestParam>", next_cursor: "$response.<nextField>", results: "$response.<itemsField>" }`; offset plans gain `{ offset: "$request.<requestParam>", results: "$response.<itemsField>" }`; page style: stamp the offset form with the page param (Fern has no distinct page type at this syntax level — record in KNOWN_GAPS); unplanned ops byte-unchanged; input never mutated.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both (pure functions; detection reuses `detectPagination` output passed in — do NOT re-detect inside Fern code).
- [ ] **Step 4: Run → PASS** + typecheck + existing fern tests green.
- [ ] **Step 5: S2 verdict is final (see spike section): no pager recipe exists.** Stamping stays (forward-compatible); make no claims of Python/Rust pager support anywhere (READMEs, docs).
- [ ] **Step 6: Commit.** `feat(fern): conditional OAuth auth-schemes + x-fern-pagination stamping from shared plans`

### Task 11: Fern goldens for the agent fixture

**Files:**
- Modify: `tests/renderers/sdk-fern-golden-helpers.ts` (`fernTreeName` + agent fixture), `scripts/gen-sdk-goldens.mts` (agent fixture in `--langs` path), `tests/renderers/sdk-fern-golden.test.ts` (2 new trees in TREES)
- Create: `tests/fixtures/golden/sdk-python-agent-minimal/**`, `tests/fixtures/golden/sdk-rust-agent-minimal/**` + manifests

- [ ] **Step 1: Wire helpers + failing lock** (trees absent → RED).
- [ ] **Step 2: Generate.** `npx tsx scripts/gen-sdk-goldens.mts --langs python,rust` (Docker). **EXECUTED REALITY (Task 10 finding):** the synthetic OAS carries NO requestBody for the token op (request-body property projection is future work), so `computeFernOAuthPlan` is null for the agent fixture and generators.yml has NO auth-schemes block — the spec §4.1 fallback applies (Python/Rust ship token/bearer-style auth + README snippet; gap recorded in Task 12). Verify structurally: generation succeeds for both languages; zero op-hash leakage; snake_case methods; python client exposes the `token` callable param; x-fern-pagination stamps present in the INPUT OAS (`fern/openapi/openapi.json` is transient — assert via `buildFernOas` unit output instead, already covered by Task 10 tests).
- [ ] **Step 3: Add structural assertions** to `sdk-fern-golden.test.ts`: both agent manifests verify; python marker `__init__.py` + rust marker `Cargo.toml`; NO `oauth_token_provider.rs` assertion (the auth-schemes path is dormant until request-body projection lands — asserting its absence is fine as a truthfulness pin).
- [ ] **Step 4: Full suite** `npm test` → exit 0.
- [ ] **Step 5: Commit.** `test(fern): python/rust agent-fixture goldens with OAuth wiring locked`

### Task 12: CI paths, KNOWN_GAPS, docs, final sweep

**Files:**
- Modify: `.github/workflows/sdk-docker.yml` (paths: + `src/renderers/pagination-detect.ts`, `src/sdk-plugins/auth.ts`, `src/sdk-plugins/pagination.ts`, agent golden paths), `KNOWN_GAPS.md`, `docs/ARCHITECTURE.md` (renderer list), `README.md` (feature bullets if present)

- [ ] **Step 1: CI updates** (the workflow is nightly `schedule` + `pull_request` — there is NO push trigger; do not add one):
  - `pull_request.paths`: add `src/renderers/pagination-detect.ts`, `src/sdk-plugins/auth.ts`, `src/sdk-plugins/pagination.ts`, and the agent golden tree paths.
  - The **byte-diff step** hardcodes the four existing tree dirs — add `sdk-python-agent-minimal` and `sdk-rust-agent-minimal` to that list.
  - The **cargo-check loop** and the **compileall loop** hardcode tree names — add the agent trees to both, otherwise the new trees are never compile-gated (success criterion 5 would silently fail).
  - The regen step itself needs no change (Task 11 already extended `scripts/gen-sdk-goldens.mts`).
- [ ] **Step 2: KNOWN_GAPS.md** — new section "Agent-ready SDK runtime (2026-06-10)": **Fern OAuth auth-schemes emission is gated and currently DORMANT — the gate requires the token endpoint's request-body fields in the synthetic OAS, and request-body property projection is future work (same family as component-schema preservation); Python/Rust ship token/bearer auth + README client-credentials snippet**; python OAuth not generator-wired even when auth-schemes fires (token callable; S1); env pickup TS-only; rust retry default 3 vs overlay 2; pagination pager emission status per S2 verdict; page-style stamped as offset for Fern; pagination auto-detect requires INLINE response schemas (`$ref`'d component schemas remain stubs in the synthetic OAS — full component preservation is future work, Task 6b decision); pagination engine residual risks (cursor empty-page+valid-cursor APIs stop early by loop-safety design; A→B→A cursor cycles are not guarded, only immediate repeats — optional maxPages escape hatch is future work; numeric-STRING page sizes are not honored for the partial-page stop); v1.1 deferrals (device flow, token cache on disk, streaming, webhooks, idempotency auto-injection).
- [ ] **Step 3: Docs sweep** — ARCHITECTURE renderer list + spec status update (Approved → Implemented).
- [ ] **Step 4: Full verification.** `npm run typecheck && npm test && npm run build; echo EXIT=$?` → all 0. Confirm existing golden byte-stability where promised (Tasks 4, 8).
- [ ] **Step 5: Commit.** `docs+ci: agent-ready SDK runtime gaps, paths, architecture notes`
