# Known Gaps — Agent-Ready Substrate (`substrate/frozen`)

Substrate freeze (`substrate/frozen`) gates Plans 2/3 (R-SDK, R-MCP). The following pre-existing gaps in the upstream extractors are documented and intentionally frozen as-is; they are NOT bugs in the substrate renderer and are tracked for Plans 2/3 implementers.

## Gap 1 — GraphQL operations render with no security

**Status:** Resolved in Plan 1.5 (commit `62bf044`). Fix: `src/extractors/graphql.ts` now emits an `auth_requires` edge per operation into the default bearer auth_scheme.

**Symptom:** GraphQL-sourced products produce `components.securitySchemes == {}` and operations have no `security` array. Frozen in `tests/fixtures/golden/oas-graphql-minimal.json` and asserted in `tests/renderers/oas.test.ts` (the GraphQL conformance test).

**Root cause:** `src/extractors/graphql.ts` emits a default bearer `auth_scheme` node but returns `edges: []` — no `auth_requires` edge connects the operation to the auth scheme. The R-OAS renderer only projects auth that has an `auth_requires` edge, so GraphQL ops project with no security.

**Implication for Plans 2/3:** GraphQL-sourced SDKs and MCP servers will not auto-inject auth headers. R-SDK should treat the auth contract as undefined for GraphQL sources until the extractor emits the edges. R-MCP should not advertise authentication metadata for GraphQL surfaces.

**Resolution path:** Out of scope for the substrate plan (Plan 1 was scoped "no extractor changes"). Fix in a follow-up: have `src/extractors/graphql.ts` push an `auth_requires` edge for each operation node into the default auth_scheme node.

## Gap 2 — OpenAPI `requestBody` not projected

**Status:** Resolved in Plan 1.5. Extractor fix: `src/extractors/openapi3-ops.ts` now emits a `kind:'parameter'` child node with `location='body'`, `schema_ref`, `name='body'`, `required`, `content_type='application/json'` claims when an op has an `application/json` `requestBody` (commit `6ad7719`). Renderer fix: `src/renderers/oas.ts` `buildParams` body branch now reads the `schema_ref` claim and projects it as a `$ref` into the `requestBody`, registering the named schema into `components.schemas` (commit `4f4b430`).

**Symptom:** OpenAPI POST/PUT/PATCH operations with a `requestBody` (e.g., `createProject` in `tests/fixtures/openapi3/minimal.yaml`) render WITHOUT a `requestBody` in the synthetic OpenAPI doc. Frozen in `tests/fixtures/golden/oas-minimal.json`.

**Root cause:** `src/extractors/openapi3-ops.ts` records request bodies as op-level claims (`request_content`) rather than as `parameter` nodes with `location: "body"`. The renderer's `buildParams` only constructs a `requestBody` when it encounters a parameter row whose `location` claim is `"body"`, so the op-level `request_content` claim is never consumed by the renderer.

**Implication for Plans 2/3:** R-SDK cannot generate typed POST/PUT/PATCH bodies from the substrate's OpenAPI projection alone. SDK renderers must either (a) read the `request_content` claim directly off the operation node, or (b) wait for the extractor to emit body parameter nodes.

**Resolution path:** Out of scope for the substrate plan. Fix in a follow-up: have `src/extractors/openapi3-ops.ts` emit a parameter child node with `location: "body"` and a `schema_ref` claim whenever an op has a `requestBody`, OR teach `src/renderers/oas.ts` to consume the existing `request_content` op-level claim.

---

**Plan 1.5 closure (2026-05-20):** Both gaps above resolved. `substrate/frozen` retagged forward at the Plan 1.5 final commit. R-OAS goldens regenerated and locked. The historical text (including the original "out of scope for the substrate plan" framing) is preserved for archaeological reference; the substrate now projects both gap shapes correctly. Plan 1.5 ended up touching `src/renderers/oas.ts` (originally listed Out of Scope in the plan header) because Gap 2 closure required projecting the new `schema_ref` claim through the renderer — see commit `4f4b430` and the plan's Task 3.5 follow-up section.

## Wedge scope — unsupported security schemes (Plan 2b)

**Status:** Deferred. `extractAuthSchemes` in `src/renderers/sdk-utils.ts` throws a hard error when it encounters an OAS `securitySchemes` entry with a type other than `http` (bearer/basic) or `apiKey`.

**Unsupported types:** `oauth2`, `openIdConnect`, `mutualTLS`.

**Symptom:** `renderSdkPackage` throws: `renderSdkPackage: unsupported security scheme '<id>' (type=<type>, scheme=<scheme>). Supported: http+bearer, http+basic, apiKey.` if the input OAS contains any of these scheme types.

**Resolution path:** Plan 2b. Each scheme type requires a distinct auth-injection strategy in the emitted `Client` class (`runtime.ts` generator). oauth2 requires a token-refresh loop; openIdConnect requires OIDC discovery; mutualTLS requires certificate management. Implement as separate `AuthSchemeDescriptor` variants and new branches in `buildAuthUnion`/`buildInjectBody`.

---

## L1 real-world findings (2026-05-22, Resend `openapi.json`, 83 ops)

Surfaced by the first end-to-end run against a real vendor spec (`init` discovery → `build` → skill + SDK). The synthetic goldens never exercised these shapes because they used a single clean namespace (`projects`), a per-operation `security` block, and human-curated operationIds.

### Gap 3 — SDK namespace crash on non-identifier resource names

**Status:** Resolved (2026-05-22, this run). Fix: `src/sdk-plugins/resource-tree.ts` `deriveNamespace` now auto-sanitizes *derived* namespaces to valid JS identifiers (`api-keys` → `apiKeys`, `contact-properties` → `contactProperties`); *explicit* overlay namespaces remain strictly validated. Already-valid names (incl. underscores) pass through verbatim, so goldens are byte-identical.

**Symptom (pre-fix):** `renderSdkPackage` threw `resource-tree: namespace "api-keys" ... is not a valid JS identifier` and aborted the entire SDK emit. Any spec with a hyphenated top-level path segment (common: `api-keys`, `payment-methods`) hit this.

**Root cause:** namespace was derived from the operation's first tag (= the path's first segment) and passed through `assertValidName`, which rejected non-`/^[A-Za-z_$][A-Za-z0-9_$]*$/` names with no sanitization fallback.

### Gap 4 — SDK emits no auth when security is declared globally

**Status:** Resolved (2026-05-27, commit `1b9435b`). Fix: `src/extractors/openapi3-ops.ts` `emitOperationAuth` now inherits the doc's top-level `security` when an operation declares none, emitting an `auth_requires` edge per inherited scheme (`src/extractors/openapi3.ts` threads `doc.security` down as `globalSecurity`). A per-op `security` array — including an empty one, which opts out — still takes precedence. Goldens stayed byte-identical (`minimal.yaml` uses per-op security). `substrate/frozen` retagged forward `dfd196c → 1b9435b`. New regression tests in `tests/extractors/openapi3.test.ts` ("global security (Gap 4 closure)").

**Symptom:** For a spec that declares `security` at the top level (global) rather than per-operation, the emitted `runtime.ts` is `AuthConfig = { kind: "none" }` with `// no auth schemes projected`. Every request goes out unauthenticated (401 against the real API). The SKILL.md auth section is unaffected (it reads `auth_scheme` nodes directly via `src/renderers/skill-auth.ts`).

**Root cause:** the OpenAPI extractor records the `auth_scheme` node (1 present for Resend) but emits **0 `auth_requires` edges** for globally-applied security. `src/renderers/oas.ts` `buildSecurity` only projects a scheme into `components.securitySchemes` when an operation has an `auth_requires` edge, so the synthetic OAS carries `securitySchemes: {}`, and `extractAuthSchemes` (`src/renderers/sdk-utils.ts`) returns `[]`. This is the OpenAPI analogue of Gap 1 (GraphQL `auth_requires`).

**Resolution path:** in `src/extractors/openapi3.ts`/`openapi3-ops.ts`, when an operation inherits a top-level `security` requirement (no operation-level override), emit an `auth_requires` edge from the operation node to the corresponding `auth_scheme` node — mirroring the Gap 1 fix in `graphql.ts`. Will require golden regen for any OpenAPI fixture that uses global `security`.

### Gap 5 — SDK method names are opaque content hashes

**Status:** Resolved (2026-05-27). Fix: `src/sdk-plugins/resource-tree.ts` now derives a readable method name from each operation when no overlay `rename` is set, via a single deterministic assignment pass (`resolveAssignments`) shared by tree-building and request emission. Rules: a path `#fragment` (GraphQL field name) wins outright; a trailing literal action segment (`/emails/{id}/cancel` → `cancel`, `/emails/batch` → `batch`) is used as-is; otherwise the HTTP verb maps to `list` (GET collection) / `get` (GET item) / `create` (POST) / `update` (PUT/PATCH) / `delete` (DELETE). Overlay `rename` still takes precedence (and an overlay-rename collision still throws as an author error). Derived collisions within a namespace are disambiguated deterministically with a short op-hash suffix instead of crashing the emit. Operation-id hashes are never surfaced as method names. SDK goldens regenerated (`projects.list/create`, `mutation.createProject`, `query.projects`).

**Symptom:** emitted resource methods are named by content-addressed operationId, e.g. `client.emails.op_cbe40e616c22a3e5()` instead of `client.emails.send()`. The official `resend` SDK exposes readable verbs.

**Root cause:** `resolveMethodName` falls back to the raw operationId (a graph hash) when no overlay `rename` is set; there is no human-readable naming pass (e.g., verb-from-HTTP-method + path-tail heuristic).

**Resolution path:** add a derivation that maps (method, path) → a readable method name (e.g., `GET /emails/{id}` → `get`, `POST /emails` → `send`/`create`), with the overlay `rename` still taking precedence and a collision-resolution rule within each namespace. Affects `src/sdk-plugins/resource-tree.ts` and golden regen.

---

## L1 real-world findings, batch 2 (2026-05-27, 7 vendor specs)

Surfaced by a second L1 sweep through `build` against real vendor specs. Stress-test specs: OpenAI (242 ops), Stripe (414 paths). Target-audience specs (the production quality bar — SMB→mid-market dev tools, see the `feedback-skillship-test-audience` memory): dub (53 ops), resend (83), val.town (36), vercel (308), sentry (216). All seven build clean, type-check, project bearer auth (Gap 4 holds), and surface no raw `op_<hash>` method names (Gap 5 holds). Four new gaps were found.

### Gap 6 — SDK namespaces are derived from the path, ignoring declared `tags`

**Status:** Resolved (2026-05-27, commit `382582d`). `src/extractors/openapi3-ops.ts` `pushTagsClaim` now emits a `tags` claim from `opDef.tags`; `src/renderers/oas.ts` `buildTags` reads it and uses the first declared tag (lowercased), and its path fallback now skips leading `v\d+`/`api`/numeric noise segments. Verified end-to-end against val.town/vercel/sentry: namespaces are now real resources (`blobs`/`files`/`projects`/`crons`/…) with zero `v1`…`v13` or single-`api` buckets. `substrate/frozen` retagged forward `1b9435b → 382582d`. Goldens byte-identical (`minimal.yaml` has no declared tags and a clean `/projects` path).

**Symptom:** version- or `api`-prefixed specs collapse into degenerate namespaces. The synthetic OAS derives each operation's namespace tag from the path's first non-template segment, so:
- val.town (`/v1/...`, `/v2/...`) → namespaces `v1`, `v2`, `v3`
- sentry (`/api/0/...`) → a single namespace `api`
- vercel (`/v1/...` … `/v13/...`) → namespaces `v1` … `v13`

The result is an SDK shaped like `client.v2.files()` / `client.api.something()` instead of `client.files()` / `client.projects()`. The vendor's *declared* OpenAPI `tags` (which carry the real resource grouping — `Projects`, `Files`, `Issues`) are never consulted. This cascades into Gap 7: collapsing many resources into one `v1`/`api` namespace forces large numbers of method-name collisions.

**Root cause:** `src/extractors/openapi3-ops.ts` `emitOperation` never captures the operation's `tags` array — it emits `method`, `path_or_name`, `summary`, etc., but no `tags` claim. Downstream, `src/renderers/oas.ts` `buildTags` therefore has nothing to read and falls back to deriving the tag purely from the path's first segment. `src/renderers/sdk-utils.ts` `extractOperations` reads `op.tags` off the synthetic OAS, and `src/sdk-plugins/resource-tree.ts` `resolveNamespace` uses `op.tags[0]` — so the path-derived tag is the namespace.

**Resolution path:** (1) `openapi3-ops.ts` emit a `tags` claim (JSON-encoded string array) from `opDef.tags` when present. (2) `oas.ts` `buildTags` read that declared-tags claim first and use the first declared tag; only when no declared tag exists, fall back to the path's first segment — and that fallback should skip a leading version segment (`/^v\d+$/`) and a leading `api` segment so version-prefixed specs degrade gracefully. Requires golden verification (`minimal.yaml` has no declared tags and a clean `/projects` path, so existing OAS/SDK goldens stay byte-identical) and likely a `substrate/frozen` retag forward because the extractor changes.

### Gap 7 — method-name collisions within a collapsed namespace fall straight to op-hash suffixes

**Status:** Resolved (2026-05-27, commit `382582d`). `src/sdk-plugins/resource-tree.ts` `resolveMethodName` now tries `qualifyWithSegment` (deepest distinguishing literal path segment → `getAttachments`-style name) before the op-hash tail; the hash remains the deterministic last resort, and overlay `rename` is still the escape hatch. Note: version-only-distinguished duplicates (e.g. vercel's `/v1/` vs `/v6/` of the same verb+resource) intentionally still fall to the op-hash tail because the version is stripped as namespace noise — overlay rename is the fix for those. `r-sdk-wedge/frozen` retagged forward `f14c62b → 382582d`.

**Symptom:** inside a degenerate namespace (Gap 6), many operations derive the same readable verb (`list`, `get`, `create`), so the deterministic disambiguator appends the op-hash tail, producing names like `client.v2.files_f8d3f9c7()`. Readability regresses toward the very hashes Gap 5 removed, just one level down.

**Root cause:** `src/sdk-plugins/resource-tree.ts` `resolveMethodName` disambiguates a collision by jumping directly to `${base}_${opHashTail(operationId)}` — there is no intermediate attempt to qualify the name with a distinguishing path segment (e.g. the resource the path acts on) before reaching for the hash.

**Resolution path:** in `deriveMethodName`/`resolveMethodName`, before the op-hash fallback, try qualifying the colliding name with a distinguishing literal path segment (e.g. a preceding collection segment) to produce `getProject` / `listFiles`-style names; keep the op-hash tail only as the last resort. Note: fixing Gap 6 (correct namespaces) dissolves most of these collisions, so Gap 7 is a bounded readability improvement, not a correctness fix.

### Gap 8 — `build` silently emits an empty SDK when a source extracts 0 operations

**Status:** Resolved (2026-05-27, commit `382582d`). `src/cli/build.ts` `runBuild` now warns (non-fatal, stderr) when `ingest.operations === 0` and `hasApiSurfaceSource(config.sources)` is true (a `rest`/`grpc` source excluding the github-repo placeholder). Docs-only/llms_txt products with 0 operations stay silent. Note: the actual `SurfaceKind` values are `rest`/`grpc` (GraphQL specs carry surface `rest` + `content_type: application/graphql`), so the guard gates on `rest`/`grpc`.

**Symptom:** if a `rest`/`graphql` source contributes zero operations to the graph (e.g. the config `content_type` does not match any extractor, so `dispatchExtractor` returns `null`), `build` exits 0 and writes a structurally valid but empty SDK — no resource methods, no signal to the operator that anything went wrong. This is how the first OpenAI run produced an empty SDK (wrong `content_type` `application/yaml` → silent dispatch miss).

**Root cause:** `src/ingest/dispatch.ts` returns `null` for an unrecognized `content_type` without surfacing it, and `src/cli/build.ts` `runBuild` never inspects `ingest.operations` (which is `0` in this case) before proceeding to render. The build has no "you asked me to ingest an API surface but I found no operations" guard.

**Resolution path:** in `runBuild`, after `ingestConfig`, if the config contains at least one `rest` or `graphql` source and `ingest.operations === 0`, emit a clear warning to stderr (naming the likely cause: `content_type` mismatch / unsupported surface). Pure-docs/llms.txt products legitimately have 0 operations, so gate the warning on the presence of an API-surface source rather than warning unconditionally. Non-fatal (warn, don't throw) to preserve docs-only builds.

### Gap 9 — SDK tsc gate resolves `tsc` from `process.cwd()`, not the package

**Status:** Resolved (2026-05-27, commit `382582d`). `src/renderers/sdk.ts` `runTypecheckGate` now resolves `tsc` via `createRequire(import.meta.url).resolve("typescript/package.json")` + `bin/tsc` instead of `process.cwd()/node_modules/.bin/tsc`. Regression test in `tests/renderers/sdk.test.ts` runs `renderSdkPackage` with `process.cwd()` chdir'd to a `node_modules`-less temp dir and asserts `typecheckExitCode === 0` (RED-confirmed before the fix). `r-sdk-wedge/frozen` retagged forward `f14c62b → 382582d`.

**Symptom:** `renderSdkPackage`'s type-check gate fails with a spurious non-zero exit (reported as `tsc --noEmit exited 1`) whenever `build` is invoked from a working directory that lacks a local `node_modules/.bin/tsc`. This produced a false "Stripe failed" result that disappeared when the same build ran from the repo root.

**Root cause:** `src/renderers/sdk.ts` `runTypecheckGate` resolves the compiler as `join(process.cwd(), "node_modules", ".bin", "tsc")`. That couples the gate to the caller's CWD instead of to where `typescript` is actually installed (the skillship package's own dependency tree).

**Resolution path:** resolve `tsc` relative to the installed `typescript` module, e.g. via `createRequire(import.meta.url).resolve("typescript/package.json")` then join to its `bin/tsc`, rather than `process.cwd()`. Add a regression test that runs `renderSdkPackage` with `process.cwd()` set to a directory lacking `node_modules` and asserts `typecheckExitCode === 0`. Affects `src/renderers/sdk.ts`; likely an `r-sdk-wedge/frozen` retag forward.

---

## Multi-language SDK — Python + Rust via Fern (2026-05-28)

The opt-in `--sdk python,rust` build flag emits idiomatic Python/Rust SDKs via the Fern code generator (`fern generate --local`, pinned Docker images). The TypeScript SDK path (`renderSdkPackage`) is unchanged and remains the zero-dependency default. The shared engine (graph → synthetic OpenAPI → `resolveAssignments` naming) is reused; only the final per-language emission differs. Three Phase-0 spikes pinned the toolchain behavior; their outcomes are recorded below alongside the deferred surface.

### Deferred output features (parity with TS Plan 2b)

**Status:** Deferred. The Fern Python/Rust SDKs project the same operation surface the TS SDK does — methods, params, request bodies, bearer/basic/apiKey auth — but do NOT model overlay-driven pagination, retries, streaming, or webhooks. This mirrors the TS SDK's Plan 2b deferral (the codegen overlay's pagination/retry/streaming/webhook fields are not wired into any emitter yet). When Plan 2b wires those into the TS path, `src/renderers/fern-oas-rewrite.ts` is where the equivalent OAS-level hints (e.g. an `x-fern-pagination` extension) would be injected for the Python/Rust path.

### Spike 0.1 — Fern accepts only a tag, not a digest, in `generators.yml`

**Decision (locked):** `FERN_PINS.generators.*.tag` is what `generators.yml`'s `version:` field uses; `pinnedVersion()` returns the tag. The immutable `sha256` digest is recorded in `FERN_PINS` for `docker pull` + golden verification ONLY — it is NOT usable in `version:`. Five forms were tested against `fern-api@5.40.0`: `version: "<digest>"` → "Failed to parse version"; `name: "<repo@digest>"` → schema reject; `name`+`version` with a digest → "Unrecognized generator … specify ir-version" (Fern infers the IR version by name-registry lookup, which a digest defeats); `image:` expects an object, not a string. Only the blessed tag path works. Drift defense is therefore Fern's immutable per-version publishing + the Docker lane's byte-diff (`.github/workflows/sdk-docker.yml`), NOT digest pinning.

**Also locked here:** `generators.yml` MUST carry an `api: { specs: [{ openapi: "openapi/openapi.json" }] }` block — without it Fern aborts with "Detected empty API definition." `FERN_PINS.cliVersion = "5.40.0"`; pinned generators: `fern-python-sdk@5.14.4`, `fern-rust-sdk@0.36.8`.

### Spike 0.2 — snake_case operationIds are required (camelCase collapses)

**Decision (locked):** `buildFernOas` rewrites each operation's `operationId` to `snake(namespace)_snake(methodName)` and `tags` to `[namespace]`, derived from the same `resolveAssignments` pass that drives the TS SDK (single source of truth, matched back to the doc by original `operationId`). Verified on the real REST + GraphQL fixtures: snake input → Python `def create_project` / Rust `fn create_project`; camelCase input → `createproject` (the bug). No `op_<hex>` leakage; namespace grouping works (`mutation/`, `query/`, `projects/`).

**Edge case (accepted, NOT pre-engineered):** `camelToSnake` is not injective, so two distinct camelCase method names in one namespace could rarely collapse to the same snake `operationId`. Fern errors LOUDLY on a duplicate `operationId` if this ever happens — that is the signal. The fix when triggered is an overlay `rename` on one of the colliding operations; do NOT add speculative disambiguation to `fern-oas-rewrite.ts`.

### Spike 0.3 — Python package layout is flat; `package_name` only sets docstring imports

**Decision (locked):** `buildFernProject` sets `config: { package_name: "skillship_sdk" }` for the Python generator (Rust takes no config). In `local-file-system` output mode the Fern Python generator emits a FLAT package (`types/`, `core/`, `errors/`, `<namespace>/` at the output root) with NO `pyproject.toml` — `package_name`/`output_directory: project-root` do NOT nest the modules; `package_name` only rewrites the import root shown in docstring example code (`from skillship_sdk import …`). Python output is byte-deterministic across runs (`.fern/metadata.json` included).

**Stdlib-shadow note:** the flat tree puts a `types/` package at the root, and `core/jsonable_encoder.py` does `from types import GeneratorType` (wanting stdlib). This only shadows if the package-root directory is placed DIRECTLY on `sys.path` (pathological); normal consumption (importing the package by name from its parent — how the sibling `sdk-python/` dir is consumed) resolves `from types import` to stdlib (verified). The Docker lane's Python compile gate runs `python3 -m compileall` from a NEUTRAL CWD (`/tmp`) as the guard. Consequently the golden marker file for the Python trees is `__init__.py`, not `pyproject.toml`.

### Determinism & enforcement

Output changes ONLY when `FERN_PINS` is bumped. Two complementary gates: (1) the pure-Node manifest lock (`tests/renderers/sdk-fern-golden.test.ts`) recomputes sha256 of every committed golden file vs the committed `<tree>.manifest.json` — runs in normal CI, no Docker, guards committed artifacts against hand-edits; (2) the Docker regen lane (`.github/workflows/sdk-docker.yml`, nightly + Fern-path PRs) regenerates with real Docker and byte-diffs vs the committed trees, then compile-gates (`cargo check`, `python -m compileall`). First run needs network for `npx fern-api@…` + the generator images; thereafter offline from cache (`skillship sdk warm`); `assertDockerAvailable` fails fast with the `warm` hint when Docker is down (the TS SDK still emits).

### Minor follow-ups (non-blocking, surfaced in code review)

- **`runBuild` length:** after wiring the Fern path and extracting `assembleSdkArtifacts`, `runBuild` (`src/cli/build.ts`) is ~54 lines — slightly over the 50-line guideline. The residual is pre-existing config/ingest/`writeAll` setup that predates this feature; a fuller sub-50 refactor (extracting the ingest-warning + setup) is a separate cleanup, out of scope here.
- **`stageProject` duplication:** `tests/cli/build-sdk-fern-noop.test.ts` inlines a copy of `stageProject()` from `tests/cli/build-sdk.test.ts` (the plan chose inlining over coupling the new test to a refactor of the green existing test; the copy carries a "keep in sync" comment). Extracting a shared test-fixture helper is a candidate cleanup.
- **Rust compile gate has no committed `Cargo.lock`:** the Fern-generated `Cargo.toml` files use semver ranges, so the Docker lane's `cargo check` resolves latest-compatible crates from crates.io on each run. Acceptable for a Fern-managed golden (Fern owns valid-Rust generation), but a `cargo check` failure may occasionally be a crates.io resolution issue rather than an SDK bug.

---

## Agent-ready SDK runtime — auth, retries, pagination (2026-06-10)

Auth, retry, and pagination capabilities landed across TS native + Python/Rust Fern paths. The following asymmetries are recorded as intentional or upstream-blocked; they are not bugs in the current implementation.

### Auth

- **Fern OAuth auth-schemes emission is DORMANT.** `computeFernOAuthPlan` in `src/renderers/sdk-fern.ts` gates the OAuth plan on request-body property projection that is not yet implemented (Gate 3: token op's requestBody must have both `client_id` and `client_secret` properties). When the plan is null, `buildAuthSchemesBlock` in `src/renderers/fern-project.ts` is never called, so `generators.yml` carries no `auth-schemes` block and the Fern generators receive only the raw `securitySchemes` entry from the OAS. Note: `fern-oas-rewrite.ts` only stamps `x-fern-pagination` and rewrites `operationId`/`tags` — it does not gate the auth-schemes block. Request-body property preservation is the reactivation trigger.

- **Rust ships complete native OAuth machinery** (`OAuthTokenProvider`, `OAuthConfig`, client_credentials fetch — emitted by Fern from the OAS `oauth2` securityScheme + `flows` that the extractor/OAS chain projects), but the generated `ApiClient` does **not** wire it automatically. The intended opt-in path is `ApiClientBuilder::oauth_credentials(client_id, client_secret)` (and individual setters), which `ApiClientBuilder` exposes. Callers who need lower-level control can also construct `OAuthConfig` and pass it directly. The README in the Rust golden tree documents the opt-in path. The honest gap is that neither route is auto-wired from env/config — the caller must opt in.

- **Python OAuth is not generator-wired.** The Fern Python client exposes `token: str | Callable` (`+async_token` on the async client); the client-credentials token-refresh loop is the caller's responsibility. The README documents the client-credentials snippet path.

- **Env-var auto-pickup is TS-only.** Neither the Fern Python nor the Fern Rust generator emits env-var wiring (neither reads `PRODUCT_TOKEN` / `PRODUCT_CLIENT_ID` from the environment automatically). Only the TS native `runtime.ts` emitter picks up env vars.

- **Rust retry default is 3 vs the overlay/TS default 2.** Fern's Rust generator hard-codes `max_retries: 3`; the TS emitter defaults to 2 (configurable via overlay). This is not configurable at generation time — it would require a Fern generator change or post-generation patching.

### Pagination

- **Pagination pagers are TS-only.** Fern's Python pager emission is gated behind a server-side org entitlement with no local override; Fern's Rust pager emission is disabled upstream (PR #9781). `x-fern-pagination` IS stamped on the OAS extensions (forward-compatible; auto-activates on regen if upstream lifts the gates). Page-style plans are stamped in Fern's offset form (no distinct page type at that syntax level).

- **Pagination auto-detect requires INLINE response schemas.** `$ref`'d component schemas remain `{type: object}` stubs in the synthetic OAS — full component-schema (and request-body property) preservation is future work. A plan is emitted only when the response schema is inlined at the operation level.

- **Pagination engine residual risks:**
  - Cursor APIs returning an empty page with a valid `next_cursor` stop early by loop-safety design (empty-page guard fires before the cursor check).
  - A→B→A cursor cycles are not guarded — only immediate same-cursor repeats are detected.
  - Numeric-STRING `page_size` values (e.g. `"10"` as a string in the query) do not activate the partial-page stop; only numeric values count.
  - An optional `maxPages` escape hatch is future work.

### Deferrals (v1.1)

OAuth device/browser flow, token cache on disk, streaming/SSE, webhook signature verification, idempotency-key auto-generation.

---

## MCP server renderer (2026-06-10)

The MCP server emitter (`src/sdk-plugins/mcp-catalog.ts`, `mcp-catalog-emit.ts`, `mcp-protocol.ts`, `mcp-server.ts`, `mcp-server-emit.ts`, `mcp-server-dispatch.ts`, `mcp-server-lit.ts`, `mcp-launcher.ts`) is implemented and golden-locked. The following deviations from the design spec and forward-work items are recorded here.

### Protocol-subset conformance — owned in-repo, no upstream SDK dependency

The emitted `src/mcp-protocol.ts` is a hand-rolled zero-dependency stdio JSON-RPC implementation that covers the MCP subset the gateway needs: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, `ping`. Unknown methods return JSON-RPC `-32601`; malformed frames return `-32700`. The `PROTOCOL_VERSION` constant in the emitter source (`src/sdk-plugins/mcp-protocol.ts`, line 60: `export const PROTOCOL_VERSION = "2025-06-18"`) is pinned to the MCP spec revision current at implementation time. There is no `@modelcontextprotocol/sdk` dependency. **Implication:** new MCP protocol features (e.g. resources, prompts, sampling, revised version negotiation) require emitter updates in `src/sdk-plugins/mcp-protocol.ts` and `mcp-server.ts`; no upstream package bump will pick them up automatically.

### Node floor for the no-build flow — ≥23.6

`bin/mcp.js` (emitted by `generateMcpLauncherModule` in `src/sdk-plugins/mcp-launcher.ts`) checks `process.versions.node` at startup and exits 1 with exactly three actionable stderr lines when `major < 23 || (major === 23 && minor < 6)`:

```
This MCP server requires Node >=23.6 (it runs TypeScript directly).
You are on Node <version>. Upgrade Node, then re-run this server.
See https://nodejs.org for the latest LTS.
```

Node 23.6 is the floor because that is when `--experimental-strip-types` became default-on (no flag required). The generated SDK is TypeScript source only — `npm run build` is **not** wired; the package has no `dist/` and `src/` is NOT excluded from the published tarball at this time (see the npm-publish posture item below). The generated `package.json`'s `engines` field reflects `"node": ">=23.6"`.

### Annotation coverage — graph claims + method heuristic fallback

`x-skillship-annotations` in the synthetic OAS (`src/renderers/oas.ts`) is projected only for operations that have at least one annotation claim in the graph. The catalog computation (`src/sdk-plugins/mcp-catalog.ts` `computeAnnotations`) applies a two-level rule: (1) if the operation's OAS entry carries an `x-skillship-annotations` extension, each key in it overrides the corresponding heuristic value; (2) absent or missing keys fall back to the HTTP-method heuristic — `GET`/`HEAD` → `readOnly: true`; `DELETE` → `destructive: true`; `GET`/`HEAD`/`PUT`/`DELETE` → `idempotent: true`; everything else → all three `false`. Operations with no OAS entry at all (e.g. GraphQL ops unreachable via `findOasOp`) receive pure heuristic values. **Implication:** ops without either graph-sourced annotations or a matching OAS entry get heuristic values only; a `POST` that is semantically idempotent but carries no annotation claim will emit `idempotent: false`.

### invoke_operation response truncation — 50,000 characters

`runInvoke` in the emitted `src/mcp-server.ts` truncates JSON response text at 50,000 characters (`MAX_RESULT_CHARS = 50000`, defined in `buildHeader` in `src/sdk-plugins/mcp-server-emit.ts`). When truncated, the response appends the literal suffix `\n…[truncated — response exceeded 50,000 characters]` before returning. This is a generation-time constant; changing the budget requires re-emitting the golden trees.

### npm-publish posture — bin/ not excluded; publishing out of scope

The generated `.npmignore` (emitted by `src/renderers/sdk-templates/render.ts`) excludes `src/` but does **not** exclude `bin/`. If a generated SDK package were published to npm as-is, the tarball would ship `bin/mcp.js` (the launcher) but NOT `src/mcp-server.ts` (the TypeScript source the launcher re-execs via `--experimental-strip-types`). The launcher would fail at startup because its target `../src/mcp-server.ts` is absent from the installed package. Publishing generated SDK packages remains out of scope and untested.

### Emitted gateway module — 366-368 lines (adjudicated deviation from 300-line budget)

The emitted `src/mcp-server.ts` artifact is 366 lines for the graphql-minimal golden and 368 lines for the minimal/agent-minimal goldens. This exceeds the 300-line house rule for generated artifacts. The deviation is intentional and controller-adjudicated: the emitter source is split across `mcp-server-emit.ts` (136 lines), `mcp-server-dispatch.ts` (253 lines), `mcp-server.ts` (63 lines), and `mcp-server-lit.ts` — all emitter files respect the 300-line rule. The emitted artifact is kept as one readable file for developer experience (a split generated module would require runtime imports across the SDK's src/ tree). No further split is planned unless the emitted size grows materially.

### Future work

- **`servers`-block projection into synthetic OAS:** the synthetic OAS has no `servers` block today; the `base_url` claim is read at build time and baked as a literal into the catalog. Projecting a `servers` block would also serve Fern environments (Fern reads `servers` for Python/Rust base-URL configuration). Deferred to avoid a three-language golden cascade; recorded in the design spec §4.5.
- **Named body params (request-body projection):** the catalog emits a single opaque `body: object` parameter for any operation with a `requestBody` (Gap 2's projection covers the OAS level; the catalog does not decompose the body schema into named fields). Callers pass the entire body as `args.body`. Named field projection requires full `$ref` resolution of component schemas — future work tracked with Gap 2.
- **Search over enriched descriptions:** the `search_operations` scorer uses the summary and description as emitted in the synthetic OAS at build time. LLM-enriched summaries (the enrich stage) are captured in the graph but only reach the OAS if they overwrite the claim that feeds `oas.ts`; no separate enrichment pass feeds the catalog. When the enrich stage is wired end-to-end, the catalog will benefit automatically because it reads from the same synthetic OAS.
- **`deps.env` does not govern auth:** `GatewayDeps.env` in the emitted gateway controls base-URL resolution and the `<PREFIX>_MCP_ALLOW_DESTRUCTIVE` override only. Auth credential resolution always calls `resolveAuthFromEnv` from the SDK's `auth.ts`, which reads the real `process.env` unconditionally. Tests that inject `deps.env` cannot override credentials without also setting `process.env` (or patching the SDK's auth module). This is intentional (auth must read real env for security) but differs from the design spec's implication that `deps.env` is the single injection point. Documented in the emitted `buildHeader` comment (`src/sdk-plugins/mcp-server-emit.ts` lines 36-38).

---

## Real-world hardening (2026-06-11)

All four gaps from the Listmonk dogfood (Spec C, design 2026-06-11) are now implemented. Residual asymmetries and footguns are documented below.

### Auth synthesis + valuePrefix (Spec C §2.1) — closed

`applyOverlayToDescriptor` in `src/renderers/sdk-utils.ts` now synthesizes an auth descriptor when `overlay.auth.mode` is set and no matching descriptor exists in the OAS (the zero-schemes case). `apiKey` synthesis uses `overlay.auth.in`, `overlay.auth.name` (default `X-API-Key`), and `overlay.auth.valuePrefix` (default `""`). `bearer` synthesis creates `{ kind: "bearer", id: "overlay_bearer" }`. The auth emitter (`auth-emit.ts`) honors `valuePrefix` conditionally — empty prefix emits the existing line verbatim, so goldens without valuePrefix are byte-stable. Env pickup derives automatically from the synthesized descriptor. The `AuthSchemeDescriptor` type gains `readonly valuePrefix?: string`. The `valuePrefix` is emitted via `JSON.stringify` so special characters and backslashes escape cleanly in the generated source.

**Gap:** `valuePrefix` applies to `apiKey` mode only. `bearer` mode has a fixed `"Bearer "` prefix per RFC. `oauth2-client-credentials` does not use a value prefix (the token is injected as `Authorization: Bearer <access_token>` by the token refresh loop).

### Envelope pagination — one-level descent only (Spec C §2.3) — closed

`detectPagination` (`src/renderers/pagination-detect.ts`) now descends into a one-level envelope: if the 200-response schema has exactly one object-typed property whose schema has exactly one array property, it emits dotted paths (`data.results`, `data.next_cursor`). The `getPath` helper in the emitted `pagination.ts` engine reads dotted paths safely (literal-key-first, then split-and-walk).

**Footgun — tier-2 product-wide style on envelope APIs:** when the overlay uses `pagination.style` (product-wide) without an explicit `fields.itemsField`, the auto-detect tier fires only at operation level. For envelope APIs where each op's response has a different top-level key, the product-wide style may not fire at all (ambiguity guard). The fix is an explicit dotted `fields.itemsField` in the overlay.

**Footgun — one-level descent only:** responses with more than one object-typed property at the top level (ambiguous envelope), or with the array nested more than one level deep, do not auto-detect. Use an explicit overlay `fields.itemsField` with a dotted path.

**Footgun — dotted property-name guard:** if a response body has a literal property whose name contains a `.` (e.g. `"data.results": [...]`), `getPath` tries the literal key first (via `hasOwnProperty`) before splitting. This means the behavior is correct for both cases but may be surprising when debugging.

### oneOf integer-branch preference (Spec C §2.3) — closed

`src/extractors/openapi3-ops.ts` param type claim: when a param schema has `oneOf`/`anyOf` and any branch is `integer`, the claim type is `integer`. The overlay path (criterion-3 override) remains for specs where integer is NOT the right paginator.

### `skillship add-source` (Spec C §2.2) — closed

`src/cli/add-source.ts` fetches a URL, content-sniffs (reusing `inferSpecContentType`), writes `.skillship/sources/<sha>.<ext>`, and rewrites `.skillship/config.yaml` (parse-validate-rewrite — never raw-append). Replace semantics when URL already exists.

**Gap — binary-unknown requires `--surface`:** when the content sniffer cannot classify a fetched document (e.g. a binary or non-text response), `add-source` exits 1 with an actionable message requesting `--surface <rest|docs|...>`. Pure binary surfaces are not supported without an explicit flag.

**Gap — orphaned cache files on replace:** when `add-source` replaces an existing URL entry in the config (refresh semantics), the old `.skillship/sources/<sha>.<ext>` file is NOT deleted. The orphaned file is inert (never loaded unless the sha appears in the config), but accumulates on repeated refreshes. A `skillship prune-sources` command is future work.

### Catalog summary fallback (Spec C §2.4) — closed

`computeCatalogEntries` (`src/sdk-plugins/mcp-catalog.ts`) now derives `summary` as: (1) `op.summary` when present; (2) first sentence of `op.description` (split on `/[.!?]\s/`, capped to 100 chars, appended with `"…"` when truncated); (3) `""`. The original `description` field is unchanged.

### openapi3-ops.ts line budget — split queued

`src/extractors/openapi3-ops.ts` is at ~535 lines (above the 300-line house rule). The split is queued: param-claims emission is a natural extraction boundary → sibling file `openapi3-ops-params.ts`. Deferred to avoid a non-hardening golden cascade; recorded here for the next maintainer.
