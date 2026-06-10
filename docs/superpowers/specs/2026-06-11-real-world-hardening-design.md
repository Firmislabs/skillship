# Real-World Hardening (Spec C) — Design

**Date:** 2026-06-11
**Status:** Implemented (2026-06-11) — see KNOWN_GAPS.md
**Repo:** skillship
**Evidence:** Listmonk dogfood (2026-06-10/11) — a 72-op real-world API built, served over MCP, and driven live. All four gaps below were demonstrated empirically, not hypothesized. Predecessors: Spec A (SDK runtime), Spec B (MCP renderer), both implemented.

## 1. Goal

Close the four gaps that separated the Listmonk dogfood from the ten-minute SLC
promise. Priority order = user impact observed:

1. **Overlay auth synthesis** (the blocker): auth-silent specs are common; the
   overlay must be able to CREATE an auth scheme, not just convert declared ones —
   including nonstandard header value prefixes (`Authorization: token user:tok`).
2. **`skillship add-source <url>`**: discovery misses docs-page spec links;
   hand-editing config.yaml is error-prone (a naive append broke the YAML).
3. **Envelope pagination detection**: `{data: {results: [...]}}` response
   envelopes defeat auto-detection; only the overlay rescued Listmonk.
4. **Catalog summary fallback**: ops with `description` but no `summary` render
   empty search lines and describe headlines.

Out of scope: collision-id cosmetics (`miscellaneous_list_21c128c3` is correct
fallback behavior); discovery crawling docs pages for spec links (bigger feature;
add-source is the 80/20); SKILL.md summary fallback (catalog-only here).

## 2. Design

### 2.1 Overlay auth synthesis + value prefix

**Overlay schema** (`src/overlays/codegen.ts`): `Auth` gains
`valuePrefix: z.string().optional()` — a literal prepended to the credential in
the header value (Listmonk: `valuePrefix: "token "` → header
`Authorization: token <value>`). Applies to `apiKey` mode only (bearer's
`Bearer ` prefix is fixed by RFC; oauth2 unchanged).

**Descriptor synthesis** (`src/renderers/sdk-utils.ts`): today
`applyOverlayToDescriptor` only converts EXISTING descriptors, and only for
`oauth2-client-credentials`. New behavior — after mapping declared schemes, when
`overlay.auth.mode` is set:
- If a descriptor of the corresponding kind already exists → leave/convert as
  today (oauth2 conversion behavior unchanged).
- If NOT (including the zero-schemes case): SYNTHESIZE one:
  - `apiKey` → `{ kind: "apiKey", id: "overlay_apikey", in: overlay.auth.in,
    name: overlay.auth.name ?? "X-API-Key", valuePrefix: overlay.auth.valuePrefix ?? "" }`
    (the descriptor type gains `readonly valuePrefix?: string`).
  - `bearer` → `{ kind: "bearer", id: "overlay_bearer" }`.
  - `oauth2-client-credentials` → the oauth2 descriptor with
    `tokenUrl: overlay.auth.tokenUrl ?? null` (synthesis-from-zero now allowed).

**Generated auth module** (`src/sdk-plugins/auth.ts`/`auth-emit.ts`): apiKey
emission honors `valuePrefix` — emitted CONDITIONALLY: when the descriptor's
prefix is non-empty, emit `headers[name] = "<prefix literal>" + auth.value;`
(and the query branch likewise prefixes the query value); when empty, emit
EXACTLY today's line — existing goldens stay byte-identical. When the overlay
sets apiKey mode and a DECLARED apiKey descriptor already exists, the overlay's
`name`/`in`/`valuePrefix` OVERRIDE the declared descriptor's (otherwise
valuePrefix would be dead for declared-auth specs). Env pickup/REQUIRED_ENV_VARS derive from the synthesized
descriptor automatically (`<PREFIX>_API_KEY` etc.), so the MCP describe auth
line and ConfigError messages light up with zero extra work.

Listmonk acceptance: overlay `{ auth: { mode: apiKey, in: header, name:
Authorization, valuePrefix: "token " } }` against the auth-silent spec yields a
working `LISTMONK_APP_API_KEY` env path end-to-end (build → SDK → MCP invoke).

### 2.2 `skillship add-source <url>`

New CLI command (`src/cli/add-source.ts`, registered in `src/cli/index.ts`):
`skillship add-source <url> [--in <dir>] [--surface <s>] [--timeout-ms <ms>]`.

- Fetches the URL (injectable fetch for tests), computes sha256, writes
  `.skillship/sources/<sha>.<ext>` (ext from content sniff).
- **Content sniffing** (when `--surface` absent): REUSE/extend the existing
  `inferSpecContentType` (`src/discovery/specSniffer.ts` — already classifies
  openapi/swagger with dispatch-matching content types). GraphQL SDL heuristic
  (`type Query`/`schema {`) → surface `rest` + `application/graphql` (the
  repo's established GraphQL convention — `graphql` is NOT a SurfaceKind; see
  `src/resolvers/githubSpecs.ts:160-161`); else `docs` + served content-type.
  `--surface` overrides. Add `application/graphql → .graphql` to the sources
  EXTENSION_MAP. NOTE: there is no validating config reader today (build does a
  raw YAML cast) — the parse-validate-rewrite path here is net-new code.
- **Config rewrite, never append**: parse `.skillship/config.yaml` (the same
  schema init writes), insert/replace the source entry (replace when the URL
  already exists — refresh semantics), recompute `coverage` with init's existing
  logic (reuse, don't duplicate), write the whole document back.
- Output mirrors init: `skillship add-source: added rest source (coverage=gold)`.
- Errors: fetch failure, unparseable config, unknown sniff with no `--surface`
  → actionable one-liners, exit 1.

### 2.3 Envelope pagination detection

`PaginationPlan.itemsField`/`nextField` become **dot-paths** (single segment =
today's behavior; `data.results` = envelope). Changes:

- **Detection** (`src/renderers/pagination-detect.ts`): auto-detect tiers, after
  the existing top-level pass finds no array prop: if the 200-response object
  has EXACTLY ONE object-typed property (the envelope, e.g. `data`) whose schema
  has EXACTLY ONE array property → descend: itemsField `"<env>.<arr>"`,
  nextField `"<env>.<next>"` when a cursor sibling exists INSIDE the envelope;
  request-param rules unchanged. Same descent applies to tier-2 product-wide
  qualification. Conservatism preserved: ambiguity at either level → no plan.
- **TS engine** (`src/sdk-plugins/pagination.ts`): emitted `paginate` reads
  fields via an emitted `getPath(obj, path)` helper (split on `.`, walk
  defensively, undefined on any miss). Single-segment paths must produce
  byte-identical behavior (and near-identical emission) to today.
- **Fern stamping** (`src/renderers/fern-oas-rewrite.ts`): dotted paths emit as
  `$response.data.results`. The prior S2 spike validated single-segment stamps
  only — the plan includes an explicit cheap verification step for dotted
  paths: `npx fern-api@<pinned> ir` (no Docker) against a dotted-path fixture
  project must succeed with the pagination node present; Docker output regen
  stays in CI.
- **Overlay**: `pagination.fields.itemsField`/`nextField` accept dot-paths
  naturally (already free strings).

**oneOf param-type resolution (review finding — third severed chain):** the
real Listmonk `per_page` is `oneOf: [integer, string "all"]` with no top-level
type; the extractor claims `"unknown"` and the synthetic OAS projects `string`,
so integer-gated page detection can never fire. Fix at the EXTRACTOR
(`src/extractors/openapi3-ops.ts` param type claim): when a param schema has
`oneOf`/`anyOf` and ANY branch is `integer`, claim `integer` (a param that can
be an integer is integer-enough for pagination); otherwise current behavior.
The overlay path (criterion-3 fallback) remains for stranger specs.

Listmonk acceptance: with NO pagination overlay, `GET /subscribers` (envelope
`{data: {results: [], total}}` + `page`/`per_page` oneOf-int params)
auto-detects as page-style with itemsField `data.results`.

### 2.4 Catalog summary fallback

`computeCatalogEntries` (`src/sdk-plugins/mcp-catalog.ts`): `summary` becomes
`op summary, else first sentence of description (split on /[.!?]\s/, cap 100
chars + "…" when truncated), else ""`. Original `description` field unchanged.
Search weighting unchanged (summary tokens still weight 3 — now populated for
description-only specs like Listmonk).

## 3. Testing

TDD throughout; unit tests per change; behavioral additions to the existing
suites: auth-synthesis render-level test (auth-silent inline spec + overlay →
generated AuthConfig has apiKey member, REQUIRED_ENV_VARS populated, applyAuth
emits the prefixed header — transpile-execute); add-source command tests with
injected fetch + tmp config round-trips (init-written config stays parseable);
envelope detection unit tests (descent, both-level ambiguity, dot-path plans)
+ engine runtime tests (getPath traversal incl. missing-envelope page) + Fern
stamp tests; catalog fallback unit tests. Golden impact: existing trees must
stay byte-identical EXCEPT where a fixture exercises new behavior — the agent
fixture gains an envelope-paginated op (`GET /events` with `{data:{results,
next_cursor}}`) so the chain is golden-locked end-to-end. This forces ONE
reviewed regen of the THREE TS trees AND (via CI Docker; locally if cheap) the
two agent Fern trees — budget both in the plan.
A new auth-silent fixture is NOT added; auth synthesis is covered by
render-level tmp tests (the golden harness has no overlay channel — keep it
that way).

## 4. Success criteria

1. Listmonk replay: from a clean `init` + add-source + the 4-line auth overlay,
   `build` → MCP invoke against the live instance succeeds with NO hand-edits
   to generated code (the dogfood's patch becomes unnecessary).
2. `add-source` round-trips the dogfood flow: `skillship add-source
   https://listmonk.app/docs/swagger/collections.yaml` produces a valid config
   with a rest source and coverage recomputed via the existing `scoreCoverage`.
3. Envelope auto-detect: subscribers-style op gains a plan with zero overlay.
4. Full suite/typecheck/build green; existing goldens byte-identical except the
   agent fixture's reviewed envelope addition + auth-emit prefix plumbing
   (empty-prefix paths byte-stable).
5. KNOWN_GAPS updated: auth-synthesis gap closed (remove/amend), envelope
   detection documented (one-level descent only), add-source documented.
