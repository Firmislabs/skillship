# Agent-Ready Renderers — Stainless-class SDK + MCP server on the skillship graph

**Date:** 2026-05-19
**Status:** Approved (design); pending spec review + user review
**Repo:** skillship (in-repo extension) — branch `feat/agent-ready-renderers`
**Supersedes:** `~/github/sdkforge/docs/superpowers/specs/2026-05-19-oss-stainless-sdk-generator-design.md` (greenfield OpenAPI-in premise — abandoned)

---

## 1. Context and Problem

The problem is **making any product agent-ready**, not "generating SDKs." An SDK
is one delivery surface; a runnable MCP server is another; `SKILL.md` / `llms.txt`
(skillship already ships these) are others. Many vendors have **no OpenAPI spec**
— so spec-in cannot be the foundation.

skillship already solves the hard, input-agnostic part: it ingests OpenAPI,
Swagger, **GraphQL SDL**, docs markdown, sitemap, `llms.txt`, MCP catalogs, SDK
types and CLI specs into a single content-addressed provenance graph (12 node
kinds, 9 edge kinds, confidence tiers, human overlays, drift/refresh, git-diff-
as-PR). Renderers are **pure deterministic projections over that graph**.

This project adds the Stainless feature set as **new renderers on the existing
graph**. Because the graph is input-agnostic, the generated SDKs and MCP servers
work for **GraphQL- or docs-sourced vendors that have no OpenAPI** — which
Stainless structurally cannot do, since Stainless requires a spec. That
generalization is the defensible differentiator; provenance is a supporting
capability, not the headline claim.

### What Stainless does well (acknowledged, not minimized)

Best-in-class idiomatic *compilable* SDKs across 6+ languages, *runnable* MCP
server generation, package-registry release automation with semver, a polished
hosted docs site, and trust/logos (OpenAI, Anthropic). skillship today produces
**zero compilable SDKs** and only a config-only `.mcp.json` (verified in
`src/renderers/mcpJson.ts`: it emits `{mcpServers:{name:{type:"http",url}}}`
pointing at an already-existing server — it does not generate one). This project
closes those two gaps; it does not claim parity on language breadth or registry
release automation at launch.

## 2. Success Criteria

Done when **all** hold, with skillship's existing test suite (359 tests) still
green:

1. **R-OAS:** `skillship` can render a deterministic synthetic OpenAPI 3.1
   document from the graph for both an OpenAPI-sourced and a GraphQL-sourced
   fixture (Stripe-like and Linear-like from skillship's eval set).
2. **O-SHAPE:** a codegen-shaping overlay in `.skillship/overlays/` (existing
   mechanism, extended schema) influences both R-SDK and R-MCP output
   (resource grouping, operation rename, pagination, retries, auth, streaming).
3. **R-SDK:** produces a publishable TS npm package that passes `tsc --noEmit`
   `strict` and an msw runtime conformance suite (pagination, retries +
   `Retry-After` + idempotency, SSE streaming as typed async iterable, typed
   error hierarchy).
4. **R-MCP:** produces a runnable MCP server (TS, `@modelcontextprotocol/sdk`,
   stdio + HTTP transports) where `tools/list` equals the operation set, tool
   input schemas derive from params/body, auth passes through, and a
   conformance test invokes representative tools against an msw-mocked upstream.
   It also rewrites `.mcp.json` to point at the generated server.
5. Determinism preserved: same graph + same overlays ⇒ byte-identical R-OAS,
   R-SDK, R-MCP output (skillship's existing renderer contract).
6. MIT, no telemetry, no hosted service, no new ingest/config system.

## 3. Architecture

Three additive pure-function renderers under `src/renderers/`, consuming the
existing SQLite graph via the existing `readBestClaim`/claims helpers. No new
repo, no new config system, no new ingest path.

```
skillship graph (existing) ─▶ R-OAS ─▶ synthetic OpenAPI 3.1 ─┬─▶ R-SDK ─▶ TS SDK npm package
                                                              └─▶ R-MCP ─▶ runnable MCP server + .mcp.json
.skillship/overlays/ (existing mechanism, O-SHAPE schema) ──────────────────┘ (feeds both)
```

**Build sequence (de-risks the solo "both in parallel" decision):** the shared
substrate (R-OAS + O-SHAPE) is implemented, tested, and **frozen behind a
committed synthetic-OpenAPI golden fixture first**. R-SDK and R-MCP are then
implemented independently against that frozen fixture, so neither blocks the
other and each is testable in isolation by one person.

## 4. Components

### 4.1 R-OAS — graph → synthetic OpenAPI 3.1
Pure renderer (`src/renderers/oas.ts`). Projects graph nodes/edges to OAS:
- `operation` (+ `has_parameter`, `returns`, `acts_on`, `auth_requires`) →
  `paths` + `operationId` + `tags` (from `resource` via `acts_on`).
- `parameter` → `parameters` / `requestBody` per `in`.
- `response_shape` → `responses` + `components.schemas`.
- `auth_scheme` → `components.securitySchemes` + `security`.
- `example` (`illustrated_by`) → `examples`.
- Optional `x-skillship-provenance` extension carrying `source_id`/`span_path`
  per operation (off by default; opt-in flag).
GraphQL-sourced graphs: queries/mutations → operations; arguments → parameters;
input objects → request schemas; unions → `oneOf`. Lossy items are emitted as
`x-skillship-unmapped` annotations rather than silently dropped (mirrors
skillship's "no silent drops" provenance principle).

### 4.2 O-SHAPE — codegen-shaping overlay
Extends the existing `.skillship/overlays/` schema (overlays already win on
conflict). New optional overlay file `codegen.yaml`:
- `resources`: operation → nested namespace mapping + rename rules.
- `pagination`: per-op/global; `cursor|offset|page` + field map.
- `retries`: `maxRetries`, exponential+jitter backoff, honor `Retry-After`,
  idempotency-key header, retryable status set.
- `auth`: `bearer|apiKey(header/query)|oauth2-client-credentials`.
- `streaming`: operations whose response is SSE → typed async iterable.
- `webhooks`: signature scheme + header names.
Validated with `zod`; invalid overlay fails the run with a typed path error.
Consumed by both R-SDK and R-MCP (single source of shaping truth).

### 4.3 R-SDK — synthetic OpenAPI → idiomatic TS SDK
Invokes `@hey-api/openapi-ts` (MIT, verified) programmatically on R-OAS output,
with base plugins (`@hey-api/typescript`, `@hey-api/sdk`) plus skillship custom
Hey API plugins: `resource-tree`, `pagination`, `retries`, `streaming`,
`errors` (typed `APIError` hierarchy), `webhooks`, `runtime` (fetch client:
timeouts, base URL, interceptors). Emits a publishable npm package
(`package.json` ESM+types+`exports`, `tsconfig` strict, generated `README`
demonstrating install/auth/one nested call/one paginated iteration, `LICENSE`,
`.npmignore`), Prettier-formatted. **Hard gate:** `tsc --noEmit` strict on the
emitted package; non-zero exit = renderer failure (exit code captured).

### 4.4 R-MCP — synthetic OpenAPI → runnable MCP server
Generates a runnable TS MCP server using `@modelcontextprotocol/sdk`:
- Each operation → one MCP tool; input JSON Schema derived from params + request
  body; description from operation summary/docs.
- Auth passthrough via server env/config (no secrets baked in).
- Pagination-aware tool results (cursor surfaced in the tool response).
- Error mapping → MCP error responses with upstream status/body.
- Transports: stdio **and** streamable HTTP.
- Emits a runnable server package + rewrites `.mcp.json` to point at the
  generated server (closes the current config-only gap).

## 5. Error Handling

Every renderer fails loud, fails fast, non-zero exit, actionable message
(skillship convention + autonomous-rules exit-code capture). Categories:
graph-empty/bronze (emit explicit placeholder, not a broken artifact — matches
skillship's documented bronze behavior), overlay-invalid (zod path), engine
failure (Hey API / MCP SDK error surfaced verbatim), typecheck-failure (R-SDK
quality gate), server-boot-failure (R-MCP quality gate). Atomic output: write to
temp, move on full success only. No partial artifacts.

## 6. Testing (TDD: RED → GREEN → REFACTOR)

skillship's existing 359-test suite must stay green (R4). New tests, written
first:
1. **Unit** — R-OAS projection per node/edge kind; O-SHAPE zod schema +
   defaults; each Hey API plugin transform; R-MCP tool-schema derivation.
2. **Golden-file** — committed synthetic-OAS golden for an OpenAPI-sourced
   fixture (Stripe-like) **and** a GraphQL-sourced fixture (Linear-like). R-SDK
   and R-MCP goldens off the frozen synthetic-OAS.
3. **Typecheck conformance** — every R-SDK golden passes `tsc --noEmit` strict.
4. **Runtime conformance** — R-SDK package run against an **msw** in-process
   mock (chosen over Prism: in-process, single Node runner): pagination,
   retries/`Retry-After`, streaming, error classes. R-MCP: boot server, assert
   `tools/list` == operation set, invoke representative tools against
   msw-mocked upstream.
The GraphQL-sourced fixture in (2)/(4) is mandatory — it proves the "works
without an OpenAPI spec" claim, the project's actual differentiator.

## 7. Dependencies and Licenses (all permissive)

| Dependency | Role | License |
|---|---|---|
| `@hey-api/openapi-ts` | TS SDK engine + plugin host (R-SDK) | MIT (verified 2026-05-19) |
| `@modelcontextprotocol/sdk` | runnable MCP server (R-MCP) | MIT |
| `zod` | O-SHAPE overlay validation | MIT (already in skillship) |
| `prettier` | format emitted SDK | MIT |
| `msw` | in-process conformance mock (dev) | MIT |
| `typescript` | R-SDK typecheck gate | Apache-2.0 (already in skillship) |
| `better-sqlite3` | graph reads | MIT (already in skillship) |

Project license: MIT (skillship's existing license). No source-available/BSL/
paid-gated dependency in the runtime path.

## 8. Risks (explicit)

- **R1 — synthetic-OAS fidelity.** GraphQL→OAS impedance (args/unions→params/
  `oneOf`); docs-only graphs project thin and stay bronze/placeholder (already
  skillship's documented status, not a regression). Mitigation: GraphQL-sourced
  fixture is a mandatory conformance gate (§6); unmapped items annotated, never
  silently dropped.
- **R2 — Hey API plugin-API drift.** Pin exact version; vendor plugin type
  contracts; CI canary runs conformance against Hey API `latest`.
- **R3 — solo "both in parallel"** (user-accepted override of the recommended
  sequential path). Mitigation: shared substrate frozen behind a committed
  golden before either renderer starts; R-SDK and R-MCP independently testable.
- **R4 — in-repo blast radius.** New renderers are additive pure functions; must
  not touch existing ingest/extractors/graph; CI (typecheck + 359 tests) must
  stay green on every commit.

## 9. Scope

**In:** R-OAS, O-SHAPE, R-SDK (TypeScript only), R-MCP (TS server).
**Out (YAGNI / separate specs):** Python and other-language SDKs, Terraform/CLI
generators, package-registry release automation (skillship's git-diff-as-PR
already provides continuous updates; registry publishing is a later decision),
hosted docs site, a direct-graph SDK emitter (the synthetic-OAS bridge is the
chosen path), docs-only-graph fidelity beyond placeholder.

## 10. Open Decisions (do not block planning)

- Synthetic-OAS provenance extension (`x-skillship-provenance`) default state —
  proposed off/opt-in; revisit after R-SDK output review.
- Whether O-SHAPE later subsumes any existing overlay fields — out of scope now;
  additive only.
