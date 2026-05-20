# Known Gaps — Agent-Ready Substrate (`substrate/frozen`)

Substrate freeze (`substrate/frozen`) gates Plans 2/3 (R-SDK, R-MCP). The following pre-existing gaps in the upstream extractors are documented and intentionally frozen as-is; they are NOT bugs in the substrate renderer and are tracked for Plans 2/3 implementers.

## Gap 1 — GraphQL operations render with no security

**Symptom:** GraphQL-sourced products produce `components.securitySchemes == {}` and operations have no `security` array. Frozen in `tests/fixtures/golden/oas-graphql-minimal.json` and asserted in `tests/renderers/oas.test.ts` (the GraphQL conformance test).

**Root cause:** `src/extractors/graphql.ts` emits a default bearer `auth_scheme` node but returns `edges: []` — no `auth_requires` edge connects the operation to the auth scheme. The R-OAS renderer only projects auth that has an `auth_requires` edge, so GraphQL ops project with no security.

**Implication for Plans 2/3:** GraphQL-sourced SDKs and MCP servers will not auto-inject auth headers. R-SDK should treat the auth contract as undefined for GraphQL sources until the extractor emits the edges. R-MCP should not advertise authentication metadata for GraphQL surfaces.

**Resolution path:** Out of scope for the substrate plan (Plan 1 was scoped "no extractor changes"). Fix in a follow-up: have `src/extractors/graphql.ts` push an `auth_requires` edge for each operation node into the default auth_scheme node.

## Gap 2 — OpenAPI `requestBody` not projected

**Symptom:** OpenAPI POST/PUT/PATCH operations with a `requestBody` (e.g., `createProject` in `tests/fixtures/openapi3/minimal.yaml`) render WITHOUT a `requestBody` in the synthetic OpenAPI doc. Frozen in `tests/fixtures/golden/oas-minimal.json`.

**Root cause:** `src/extractors/openapi3-ops.ts` records request bodies as op-level claims (`request_content`) rather than as `parameter` nodes with `location: "body"`. The renderer's `buildParams` only constructs a `requestBody` when it encounters a parameter row whose `location` claim is `"body"`, so the op-level `request_content` claim is never consumed by the renderer.

**Implication for Plans 2/3:** R-SDK cannot generate typed POST/PUT/PATCH bodies from the substrate's OpenAPI projection alone. SDK renderers must either (a) read the `request_content` claim directly off the operation node, or (b) wait for the extractor to emit body parameter nodes.

**Resolution path:** Out of scope for the substrate plan. Fix in a follow-up: have `src/extractors/openapi3-ops.ts` emit a parameter child node with `location: "body"` and a `schema_ref` claim whenever an op has a `requestBody`, OR teach `src/renderers/oas.ts` to consume the existing `request_content` op-level claim.
