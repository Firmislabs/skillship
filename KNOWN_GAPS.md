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
