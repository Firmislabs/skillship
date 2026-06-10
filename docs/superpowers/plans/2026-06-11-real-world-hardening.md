# Real-World Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four Listmonk-dogfood gaps (spec: `docs/superpowers/specs/2026-06-11-real-world-hardening-design.md`): overlay auth synthesis + valuePrefix, `skillship add-source`, envelope pagination with dot-paths + oneOf type resolution, catalog summary fallback — ending with a no-hand-edits Listmonk replay.

**Architecture:** Three disjoint Wave-1 tasks run CONCURRENTLY (auth synthesis; add-source; envelope/dot-path pagination), then Wave 2 consolidates (summary fallback + agent-fixture envelope op + the single golden regen incl. local Docker Fern regen + KNOWN_GAPS) and the controller replays Listmonk live. Same concurrency protocols as the MCP plan (own-files staging with index.lock retry; own-test-files-only verification; cross-file proofs at controller-run wave boundaries).

**Tech Stack:** as previous plans. Worktree `/Users/riteshkewlani/github/skillship/.worktrees/real-world-hardening`, branch `real-world-hardening`. Docker available (Fern images cached). Listmonk instance live at `http://localhost:9000` (token in controller's hands).

**Verification idiom:** `set -o pipefail; <cmd> 2>&1 | tail -5; echo "EXIT=$?"`. Known machine condition: cli/eval "Test timed out in 5000ms" under load → rerun those files with `--testTimeout=30000`; only assertion failures are real. Commits: HEREDOC + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; never hand-edit goldens.

---

## Wave 1 (three concurrent tasks, disjoint files)

### Task C1: Envelope pagination + dot-paths + oneOf type resolution

**Files (exclusive):**
- Modify: `src/extractors/openapi3-ops.ts` (param type claim: `oneOf`/`anyOf` with ANY integer branch → claim `integer`; else current behavior)
- Modify: `src/renderers/pagination-detect.ts` (envelope descent, both auto-detect tier and `qualifiesForProductWide`)
- Modify: `src/sdk-plugins/pagination.ts` (emitted `getPath(obj, path)` helper; field reads via it; single-segment behavior byte-equivalent)
- Tests: `tests/extractors/` (oneOf), `tests/renderers/pagination-detect-*.test.ts` (envelope cases), `tests/sdk-plugins/pagination.test.ts` (runtime dot-path traversal via the transpile-execute harness), `tests/renderers/fern-oas-rewrite.test.ts` (dotted stamp passthrough — stamping code itself needs NO change, fields interpolate mechanically; add the assertion)

**Contract:**
- Detection descent (spec §2.3): top-level no array prop AND exactly ONE object-typed property (envelope) whose schema has exactly ONE array prop → itemsField `"<env>.<arr>"`; cursor nextField only from INSIDE the envelope (`"<env>.<next>"`); request-param rules unchanged (now satisfiable thanks to oneOf-integer claims); ambiguity at either level → no plan. Same descent in tier-2 qualification.
- Emitted engine: `getPath` splits on `.`, walks defensively, undefined on miss; cursor/offset/page stops unchanged; runtime tests: envelope 3-page cursor iteration, missing envelope mid-stream → clean stop/typed error per existing missing-itemsField contract.
- oneOf: extractor test — param `oneOf:[{type:integer},{type:string,enum:[all]}]` → `integer` claim; renderer projects integer; detection fires.
- **Fern dotted-path verification step (in-task, no Docker):** build a minimal Fern project in /tmp (copy the shape from the prior spike at `docs/superpowers/plans/2026-06-10-agent-ready-sdk-runtime.md` S1 section / `src/renderers/fern-project.ts` output) whose OAS carries `x-fern-pagination: { cursor: "$request.cursor", next_cursor: "$response.data.next_cursor", results: "$response.data.results" }`; run `npx fern-api@5.45.3 ir /tmp/out-ir.json` → exit 0 AND the IR contains the pagination node. Paste evidence in the report. If REJECTED: stamping for multi-segment plans is suppressed (single-segment only) + KNOWN_GAPS note — report it.
- TDD RED-first per change; do NOT run golden lock/full suite (the emitted-engine change WILL red the lock — boundary handles regen).

Commit: `feat(pagination): envelope detection, dot-path engine, oneOf integer params`

### Task C2: `skillship add-source <url>`

**Files (exclusive):**
- Create: `src/cli/add-source.ts`; Modify: `src/cli/index.ts` (register command)
- Reuse (read-only imports): `src/discovery/specSniffer.ts` (`inferSpecContentType` — extend IN THIS FILE only if GraphQL sniffing requires it; it's yours this wave), `src/discovery/config.ts` (`scoreCoverage`/`buildConfig`), `src/sources/store.ts` (cache write + `extensionFor`; add `application/graphql → .graphql` to EXTENSION_MAP — yours this wave)
- Tests: `tests/cli/add-source.test.ts` (injected fetch; tmp dirs)

**Contract (spec §2.2):** fetch (injectable) → sniff (reuse sniffer; GraphQL SDL heuristic → surface `rest` + `application/graphql`; `--surface` override) → sha256 + cache via store conventions → parse `.skillship/config.yaml` (net-new validating reader — zod schema matching what init writes; reject unparseable with actionable error), insert OR replace-by-url, recompute coverage via `scoreCoverage`, rewrite whole document. Output one line mirroring init. Errors: fetch failure / unknown sniff without --surface / bad config → one-line stderr + exit 1. Tests: openapi-yaml round-trip (config valid + coverage recomputed + cache file landed), replace-by-url refresh, swagger json, graphql SDL, docs fallback, each error path; a round-trip of an ACTUAL init-written config (generate via the init code path or a verbatim fixture copy).

Commit: `feat(cli): add-source command — fetch, sniff, cache, config rewrite`

### Task C3: Overlay auth synthesis + valuePrefix

**Files (exclusive):**
- Modify: `src/overlays/codegen.ts` (Auth gains `valuePrefix: z.string().optional()`)
- Modify: `src/renderers/sdk-utils.ts` (synthesis per spec §2.1: zero-or-missing-kind → synthesize apiKey/bearer/oauth2-cc descriptors; overlay apiKey OVERRIDES a declared apiKey's name/in/valuePrefix)
- Modify: `src/sdk-plugins/runtime.ts` (apiKey descriptor gains `readonly valuePrefix?: string`)
- Modify: `src/sdk-plugins/auth-emit.ts` (CONDITIONAL emission: non-empty prefix → `headers[name] = "<prefix>" + auth.value;` and query branch prefixes the value; empty → EXACTLY today's lines — byte-stability is a hard requirement)
- Tests: `tests/overlays/codegen.test.ts`, `tests/renderers/sdk-utils.test.ts`, `tests/sdk-plugins/auth.test.ts` (+ transpile-execute runtime tests: prefixed header lands; env pickup yields `<PREFIX>_API_KEY`; REQUIRED_ENV_VARS populated from a SYNTHESIZED descriptor)

**Contract:** spec §2.1 verbatim. Byte-stability proof IN-TASK is allowed for THIS task only via emitter unit output comparison (generate auth module for existing-golden descriptor sets pre/post — byte-identical), NOT via the golden lock. TDD RED-first.

Commit: `feat(auth): overlay synthesis from zero schemes + apiKey valuePrefix`

> **Wave-1 boundary (controller):** full `npm test` EXPECTED partially red (C1's engine change vs goldens) → controller regenerates nothing yet; verifies C2/C3 suites + typecheck; golden regen happens ONCE in Wave 2.

## Wave 2 (single task, then controller replay)

### Task C4: Summary fallback + fixture + the single regen + docs

**Files:**
- Modify: `src/sdk-plugins/mcp-catalog.ts` (summary = op.summary || firstSentence(description, 100-char cap + "…") || ""), test in `tests/sdk-plugins/mcp-catalog.test.ts`
- Modify: `tests/fixtures/openapi3/agent-minimal.yaml` (+ `GET /events`: query params `cursor` string + `per_page` as `oneOf:[integer, string]`; inline 200 schema `{type: object, properties: { data: { type: object, properties: { results: {type: array, items: {...}}, next_cursor: {type: [string, "null"]} } } }}` — exercises envelope + oneOf end-to-end)
- Regenerate: ALL THREE TS golden trees (`npx tsx scripts/gen-sdk-goldens.mts`) — review by category: every tree's `pagination.ts` gains getPath (engine change); agent tree gains the events op (catalog entry with summary fallback if you give events only a description — DO that: description-only op pins C4 in the golden), envelope plan literals in resources, dotted x-fern stamps verified at unit level. THEN the two agent Fern trees via `npx tsx scripts/gen-sdk-goldens.mts --langs python,rust` (Docker, local — budget ~5 min) — review: plain methods (no pagers — upstream-gated), no extension leakage (the strip covers annotations; x-fern-pagination IS expected in the Fern INPUT but not in OUTPUT trees — verify none leaked).
- Modify: `KNOWN_GAPS.md` — amend the Spec A/B entries: auth-synthesis gap CLOSED (overlay creates schemes + valuePrefix); envelope detection documented (one-level descent only; deeper nesting → overlay); oneOf resolution (integer-branch preference); add-source documented in README.md (CLI section) if one exists — check; spec status header → Implemented.
- Behavioral: extend `tests/renderers/mcp-server-behavior-b.test.ts` OR a new file — the events op through the gateway: describe shows the fallback summary; invoke with envelope pagination params routes correctly (fake fetch).

**Steps:** TDD for C4 unit; fixture; regen (TS then Fern); review-by-category report; full gates (`npm test`/typecheck/build/golden suites all exit 0); KNOWN_GAPS; ONE commit: `feat(mcp)+docs: summary fallback, envelope fixture, golden regen, gaps closed`

> **Wave-2 boundary + LISTMONK REPLAY (controller, success criterion 1):** with the live instance: fresh `init --domain listmonk.app` → `add-source https://listmonk.app/docs/swagger/collections.yaml` → write the 4-line auth overlay (apiKey/header/Authorization/valuePrefix "token ") → `build` → set `LISTMONK_APP_API_KEY` → MCP invoke (create + gated delete + paginated list with NO pagination overlay) — ZERO hand edits to generated code. Findings recorded; success criteria 1-5 checked.

## Success criteria

Spec §4 items 1-5, verified at the Wave-2 boundary replay.
