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
