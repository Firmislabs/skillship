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
