# Real-World Dogfood Findings — Listmonk, Grocy, Wiki.js (2026-06-10/11)

Three open-source products, none with a vendor CLI or MCP server, each
self-hosted locally in Docker, each taken through the full user flow:
`init` → `add-source` → `build` → live MCP loop (search / describe / invoke /
destructive gate) against the running instance, with effects independently
verified via the product's own API. Targets were chosen to maximize variety.

| | Listmonk | Grocy | Wiki.js 2.x |
|---|---|---|---|
| Surface | REST OpenAPI 3.0 | REST OpenAPI 3.1 | GraphQL SDL |
| Auth in spec | NONE (auth-silent) | declared apiKey header `GROCY-API-KEY` | none (bearer JWT in practice) |
| Schema style | inline envelopes | `$ref`-heavy (233 refs / 52 schemas) | namespaced two-level SDL |
| Pagination | page/per_page (oneOf int) | limit/offset ($ref'd params) | limit args |
| Ops | 72 | 86 | 119 leaf (36 root stubs) |
| Build | ✓ 1.3 s | ✓ zero errors | ✓ parses, but see Tier 2 |
| Live MCP loop | ✓ full CRUD + gate | ✓ full CRUD + gate | ✗ 0% invokable |
| 10-min SLC | PASS (post-Spec-C replay, zero hand edits) | conditional pass (~6 min once past spec-fetch 401) | FAIL — "success theater" |

## Proven by these runs

- The REST chassis end-to-end: both auth modes (declared scheme → env vars
  with no config; auth-silent spec → 4-line overlay synthesis with
  `valuePrefix`), retries, envelope/oneOf pagination auto-detection, the
  confirm gate (refusal → `confirm: true` → independently verified deletion),
  response-body round-trips, truncation, and the stdio MCP protocol against
  real instances.
- OpenAPI 3.0 AND 3.1 parse cleanly; schema-level `$ref`s are fine.
- The Spec C hardening replay on Listmonk: `init` → `add-source` → overlay →
  `build` → live create/paginate/gate/delete with ZERO edits to generated code.

## Tier 1 — REST polish gaps (proposed Spec D, one cycle)

1. **`$ref`'d PARAMETERS silently dropped** (HIGH). `emitParameters`
   (`src/extractors/openapi3-ops.ts:219-223`) skips `{"$ref": ...}` entries and
   never reads path-item-level `parameters` (`:82`). Grocy: 37 refs across 10
   ops vanished — `limit`/`offset`/`query` unreachable, pagination detection
   0/86 as collateral, no build warning. Fix: resolve
   `#/components/parameters/*` + merge path-item params.
2. **`add-source` cannot authenticate** (HIGH for self-hosted). Instance-gated
   spec endpoints (Grocy gates its own `/api/openapi/specification`) → HTTP 401
   surfaces as a raw stack trace; no `--header` flag. The query-param
   workaround then leaks the credential into `config.yaml` AND the shippable
   `manifest.json` (`sources[].url`). Fix: `--header` flag + redact credentials
   from recorded source URLs.
3. **204 No Content renders as empty MCP output** (LOW/MED). A confirmed
   destructive invoke returned a zero-length text block — agent cannot
   distinguish success from no-op. Emit e.g. `204 No Content (success)`.
4. **Discovery has no instance concept** (MED). `init --domain demo.grocy.info`
   → 0 sources with no guidance; for self-hosted products the spec lives on the
   instance, not the vendor domain. At minimum: a hint suggesting `add-source`.
5. **Artifact naming follows the init domain, not the actual source** (LOW) —
   Grocy artifacts branded `DEMO_GROCY_INFO_*` though every byte came from
   localhost.
6. **Keyword search struggles with generic-CRUD entity APIs** (LOW) — Grocy's
   `/objects/{entity}` pattern puts entity names in path params, so "shopping
   list" surfaces `*_list` ops instead of the CRUD ops that answer the intent.
7. **Interim honesty fix (do first):** a loud `build` warning for GraphQL
   sources — "GraphQL support is preview: namespace-level extraction only,
   invoke unsupported" — so users stop getting Tier-2's silent emptiness.

## Tier 2 — GraphQL is structurally unshipped (proposed Spec E, own cycle)

Wiki.js produced 72 healthy-looking artifacts containing 0 of 119 real
operations. Findings (full detail in the run report, preserved artifacts at
`/tmp/wikijs-dogfood/skills/wiki-js-org/` while they last):

- **F1 (CRITICAL)** Namespaced SDL → 36 root stubs only; `collectRootFields`
  (`src/extractors/graphql.ts:99-115`) never recurses into namespace return
  types (`PageQuery` etc.) despite capturing the `returns` claim.
- **F2 (CRITICAL)** Silent 36→19 loss: `src/renderers/oas.ts:32-34` keys
  `POST /graphql#<name>` so Query.X and Mutation.X collide; arbitrary winner;
  SKILL.md says 36 while the catalog says 19; nothing warns.
- **F3 (CRITICAL)** No GraphQL document is ever constructed — the SDK POSTs to
  `/graphql#ns` with NO body; every invoke 500s; `routeArgs` blocks any escape
  (`unknown_args: query`). Independent of F1/F2 — flat schemas fail equally.
- **F4 (HIGH)** Mutations not flagged destructive (method heuristic sees only
  POST); the confirm gate is inert for GraphQL — a live safety hole the moment
  F3 is fixed.
- **F5 (MED)** Surface labeled `rest` end-to-end (`graphql` is not a
  SurfaceKind); **F6 (HIGH)** references/describe/llms.txt near-empty (the
  `returns` claims are never rendered; llms.txt was 2 lines); **F7 (MED)**
  invoke errors discard the response body, and HTTP-200-with-`errors[]` would
  read as success; **F8 (MED)** `init` never probes `<domain>/graphql`
  introspection.

**Spec E outline (from the run report):** (1) leaf-op expansion (cycle-safe
one-level recursion through arg-less object-typed root fields; Wiki.js fixture
must yield exactly 119 ops); (2) native invoke path — catalog carries op type +
field path + typed variables; a document builder emits the operation with a
depth-limited default selection set; wire = `POST /graphql` with
`{query, variables}`; (3) collision-proof rendering keyed by op type; any
extracted-vs-rendered count mismatch fails the build loudly; (4) query →
readOnly, mutation → destructive-by-default (overlay-overridable);
(5) first-class `graphql` SurfaceKind + rendered returns/args/examples;
(6) introspection discovery probe + introspection-JSON source type; (7) error
fidelity (body excerpts; `errors[]` → isError); (8) fixtures: namespaced +
flat + introspection, plus a mock-`/graphql` contract test pinning the exact
document sent.

## Reproduction notes

- Listmonk instance (left running for interactive testing):
  `docker compose` in `/tmp/listmonk-dogfood`, UI http://localhost:9000,
  API user `skillship_api` (token in the compose session; recreate via
  Admin → Users if lost). Replay artifacts: `/tmp/lm-replay/skills/listmonk-app/`.
- Grocy and Wiki.js containers/volumes were torn down after their runs.
- All three runs used the shipped `main` (Specs A+B+C) via
  `node dist/cli/index.js`.
