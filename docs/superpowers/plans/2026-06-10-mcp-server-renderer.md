# MCP Server Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `skillship build` emits a working zero-dependency MCP server (gateway: `search_operations`/`describe_operation`/`invoke_operation`) inside the generated TS SDK package, wired into `.mcp.json`, so the product works in Claude Code/Cursor with no install step.

**Architecture:** Three new generated modules inside the SDK package (`mcp-catalog.ts` — literal operation index; `mcp-protocol.ts` — stdio JSON-RPC subset; `mcp-server.ts` — gateway with pure `handleMessage` core) + `bin/mcp.js` launcher. Catalog derives from the SAME passes as the SDK (`extractOperations`/`resolveAssignments`/`detectPagination`/`extractAuthSchemes`), so names cannot drift. Two chain closures land first: annotation ingestion/projection and baseUrl plumbing. Spec: `docs/superpowers/specs/2026-06-10-mcp-server-renderer-design.md`.

**Tech Stack:** TypeScript (Node ≥20 repo; generated MCP entry requires the spike-determined Node floor), vitest, existing golden/manifest/tsc-gate infrastructure, zero new dependencies anywhere.

**Worktree:** `/Users/riteshkewlani/github/skillship/.worktrees/mcp-server`, branch `mcp-server-renderer`.

---

## Spike S1 outcome (folded in before plan review)

**S1-PLACEHOLDER** — launcher mechanism, import-specifier rule for generated MCP modules, minimal ambient declaration block for the tsc gate, Node floor, smoke-test `skipIf` expression. This section is replaced with verified results before execution begins; Tasks 4, 5, and 6 reference it.

---

## Parallelization map (user directive: parallelise wherever possible)

Execution proceeds in WAVES. Tasks within a wave own DISJOINT files and are dispatched as concurrent implementer subagents; reviews for a wave also run concurrently. Tasks across waves are sequential (later waves consume earlier interfaces).

| Wave | Tasks | Why safe to parallelize |
|---|---|---|
| 1 | T1 (annotation chain) ∥ T2 (baseUrl plumbing) | T1 owns `src/extractors/openapi3-ops.ts` + `src/renderers/oas.ts` + `src/renderers/fern-oas-rewrite.ts` + the fixture; T2 owns `src/cli/build.ts` + `src/renderers/sdk.ts` (input type only). Zero file overlap. Both render-invisible (see per-task notes). |
| 2 | T3 (catalog emitter) ∥ T4 (protocol emitter) | Both create NEW files only (own emitter + own test file). Unwired — golden lock unaffected. |
| 3 | T5 (gateway emitter) | Consumes T3/T4 emitted-module interfaces; single task. New files only, unwired. |
| 4 | T6 (big-bang wiring + launcher + .mcp.json + templating + --skip-mcp + golden regen) | Single task by design — the one reviewed golden regeneration. |
| 5 | T7 (behavioral + smoke suites) ∥ T8 (KNOWN_GAPS/docs/CI) | T7 owns new test files; T8 owns KNOWN_GAPS.md/docs/workflows. Disjoint. |

**Concurrent-commit protocol (MANDATORY for same-wave implementers):** stage ONLY your task's listed files by exact path (never `git add -A`); if `git commit` fails with an index.lock error, retry up to 5 times with `sleep 2` between attempts. Run targeted test files, not the full suite, for RED/GREEN (full-suite verification happens at wave boundaries by the controller).

---

## File map

| File | Task | Role |
|---|---|---|
| `src/extractors/openapi3-ops.ts` (M) | T1 | Ingest per-op `x-skillship-annotations` → `is_destructive`/`is_read_only`/`is_idempotent` claims |
| `src/renderers/oas.ts` (M) | T1 | Project annotation claims → `x-skillship-annotations` on synthetic-OAS ops |
| `src/renderers/fern-oas-rewrite.ts` (M) | T1 | STRIP `x-skillship-annotations` from the Fern input doc (internal extension; zero Fern-drift risk) |
| `tests/fixtures/openapi3/agent-minimal.yaml` (M) | T1 | `POST /items` gains `x-skillship-annotations: { destructive: true }` |
| `src/cli/build.ts` (M) | T2 | Read `base_url` via `readBestClaim(db, stableId("sfc", [productId, "rest"]), "base_url")`; thread `string \| null` |
| `src/renderers/sdk.ts` (M) | T2+T6 | T2: `RenderSdkInput.baseUrl: string \| null` (unused). T6: emit MCP modules + bin unless `skipMcp` |
| `src/sdk-plugins/mcp-catalog.ts` (C) | T3 | `computeCatalogEntries(...)` + `generateMcpCatalogModule(entries): string` |
| `src/sdk-plugins/mcp-protocol.ts` (C) | T4 | `generateMcpProtocolModule(): string` (static; S1 ambient block) |
| `src/sdk-plugins/mcp-server.ts` (C) | T5 | `generateMcpServerModule(opts): string` (gateway; split `mcp-server-emit.ts` if >300) |
| `src/renderers/sdk-templates/render.ts` + tpl (M) | T6 | Conditional `bin` entry + "Use with Claude Code" README section |
| `src/renderers/mcpJson.ts` (M) | T6 | Add generated-server stdio entry (relative path) when MCP emitted |
| `src/cli/index.ts` (M) | T6 | `--skip-mcp` flag |
| `tests/fixtures/golden/sdk-*/` (regen) | T6 | All 3 TS trees gain mcp modules + bin + README section |
| `tests/renderers/mcp-server-behavior.test.ts` (C) | T7 | In-process gateway conversations (fake fetch/env) |
| `tests/renderers/mcp-server-smoke.test.ts` (C) | T7 | Spawn committed golden `bin/mcp.js`, real stdio handshake (S1 skipIf) |
| `KNOWN_GAPS.md`, `docs/ARCHITECTURE.md`, `.github/workflows/*` (M) | T8 | Gaps, docs, CI paths |

Verification idiom everywhere: `set -o pipefail; <cmd> 2>&1 | tail -5; echo "EXIT=$?"`. Known machine condition: full-suite cli/eval "Test timed out in 5000ms" under load → rerun those files with `--testTimeout=30000`; only assertion failures are real. Commits: HEREDOC messages ending `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; never `--amend`/`--no-verify`; never hand-edit goldens.

---

### Task 1 (Wave 1): Annotation chain — ingest, project, strip-for-Fern

**Files:**
- Modify: `src/extractors/openapi3-ops.ts` (where per-op claims are pushed — follow the `schema_json` pattern committed in Spec A)
- Modify: `src/renderers/oas.ts` (operation emission)
- Modify: `src/renderers/fern-oas-rewrite.ts` (strip the extension from the Fern input)
- Modify: `tests/fixtures/openapi3/agent-minimal.yaml`
- Test: `tests/extractors/openapi3-ops-annotations.test.ts` (C), extend `tests/renderers/oas.test.ts`, extend `tests/renderers/fern-oas-rewrite.test.ts`

- [ ] **Step 1: Failing extractor tests.** Spec op with `x-skillship-annotations: { destructive: true, readOnly: false }` → operation node carries `is_destructive: true` + `is_read_only: false` claims (attested, span_path `...x-skillship-annotations`); only boolean keys among `destructive`/`readOnly`/`idempotent` ingested (unknown keys ignored, non-boolean values ignored); ops without the extension emit no annotation claims. RED exit captured.
- [ ] **Step 2: Implement ingestion** (≤50-line helper `pushAnnotationClaims`), GREEN.
- [ ] **Step 3: Failing OAS-renderer tests.** Graph op with `is_destructive: true` claim → synthetic-OAS operation carries `"x-skillship-annotations": { "destructive": true }` (only the keys whose claims exist — no defaults at this layer); no claims → no extension key. RED → implement in the op-emission path (read claims like siblings) → GREEN.
- [ ] **Step 4: Failing Fern-strip test.** `buildFernOas` output contains NO `x-skillship-annotations` anywhere even when the input does (internal extension; keeps Fern input byte-stable so the nightly Docker lane cannot drift). RED → implement (delete during the existing per-op rewrite pass) → GREEN.
- [ ] **Step 5: Fixture.** Add to `POST /items` in `agent-minimal.yaml`: `x-skillship-annotations: { destructive: true }`. End-to-end pin: ingest fixture → render synthetic OAS → the POST op carries the extension (real pipeline, no hand-built docs — extend the existing e2e pattern from `tests/renderers/pagination-detect-e2e.test.ts`).
- [ ] **Step 6: Golden safety proof.** `npx vitest run tests/renderers/oas-golden.test.ts tests/renderers/sdk-golden.test.ts tests/renderers/sdk-fern-golden.test.ts` → ALL PASS: existing fixtures carry no extensions (OAS goldens byte-stable); the agent fixture's synthetic OAS changes but hey-api ignores unknown op-level extensions so the rendered TS tree must be byte-identical — if the TS golden lock goes red, STOP and report BLOCKED with the diff (do NOT regenerate); Fern goldens unaffected (strip + manifest check green).
- [ ] **Step 7: Commit** (own files only, index.lock retry protocol): `feat(oas): annotation chain — x-skillship-annotations ingest + project + Fern strip`

### Task 2 (Wave 1): baseUrl plumbing

**Files:**
- Modify: `src/cli/build.ts` (read in `runBuild`/`writeAll` scope where `handle.db` lives; NEVER pass db into the SDK renderer)
- Modify: `src/renderers/sdk.ts` (`RenderSdkInput` gains `baseUrl: string | null`; stored on wedge inputs, UNUSED by emitters until T6 — rendered output must not change)
- Test: extend the existing build test file (`grep -rl "assembleSdkArtifacts\|runBuild" tests/cli/`) + a unit test on the claim read

- [ ] **Step 1: Failing test.** Build against the agent fixture (it declares `servers: [{ url: https://api.agentmin.test/v1 }]` — verify the exact URL by reading the fixture first) → the value passed into `renderSdkPackage` is that URL (assert via the render-input seam or a small exported helper `readRestBaseUrl(db, productId): string | null`); fixture/spec without servers → null. RED.
- [ ] **Step 2: Implement.** `readRestBaseUrl` uses `stableId("sfc", [productId, "rest"])` + `readBestClaim(db, surfaceId, "base_url")` (import what `src/extractors/openapi3.ts:70` and the oas.ts claim-readers already use; if `readBestClaim` isn't exported where needed, export it — note it). Thread through `assembleSdkArtifacts` → `RenderSdkInput`. GREEN.
- [ ] **Step 3: Render-invisibility proof.** `npx vitest run tests/renderers/sdk-golden.test.ts` → PASS (baseUrl accepted but unused — byte-identical trees).
- [ ] **Step 4: Commit** (own files only, retry protocol): `feat(sdk): plumb REST surface base_url into RenderSdkInput`

> **Wave-1 boundary (controller):** after both commits land, run full `npm test` + typecheck; then dispatch Wave-1 reviews (T1 spec ∥ T2 spec, then T1 quality ∥ T2 quality — or all four concurrently if reviewer load allows) before Wave 2.

### Task 3 (Wave 2): Catalog emitter

**Files:**
- Create: `src/sdk-plugins/mcp-catalog.ts`
- Test: `tests/sdk-plugins/mcp-catalog.test.ts`

Two exports:

```ts
export interface CatalogParam { readonly name: string; readonly in: "path" | "query" | "body"; readonly type: string; readonly required: boolean; }
export interface CatalogEntry {
  readonly id: string;                       // snake(namespace)_snake(method) — reuse camelToSnake from fern-oas-rewrite
  readonly accessor: readonly [string, string];
  readonly httpMethod: string; readonly path: string;
  readonly summary: string; readonly description: string;
  readonly searchText: string;               // lowercase concat: id + summary + path + description
  readonly params: readonly CatalogParam[];
  readonly annotations: { readonly destructive: boolean; readonly readOnly: boolean; readonly idempotent: boolean };
  readonly paginated: boolean;
}
export function computeCatalogEntries(ops, oasJson, overlay): readonly CatalogEntry[];  // same input style as detectPagination
export function generateMcpCatalogModule(entries: readonly CatalogEntry[]): string;     // emits the literal array + CatalogEntry type
```

Annotation resolution inside `computeCatalogEntries`: `x-skillship-annotations` from the OAS op when present (per-key); absent keys → heuristic: GET/HEAD → readOnly true; DELETE → destructive true; idempotent per HTTP semantics (GET/HEAD/PUT/DELETE true). Params: path/query from OAS parameters (name/schema.type/required); requestBody present → one `{ name: "body", in: "body", type: "object", required: <requestBody.required ?? false> }`. `paginated` = plan exists in `detectPagination` output (call it inside, or accept the map — match `detectPagination`'s signature style and reuse it; do NOT re-derive pagination logic). Entries sorted by id (deterministic). Emitted module: header comment convention, the `CatalogEntry`/`CatalogParam` types, `export const CATALOG: readonly CatalogEntry[] = [...]` literals — nothing else; <300 lines emitted for the agent fixture (catalog scales with op count; that's inherent — note per-file size only for OUR source).

- [ ] **Step 1: Failing tests** — computation (annotation precedence: extension beats heuristic; heuristic table; params mapping incl. opaque body; searchText lowercased; sorted ids; paginated flag from real detectPagination on a cursor fixture) + emission (literal array source patterns; determinism: two calls byte-identical). RED.
- [ ] **Step 2: Implement** (helpers ≤50 lines; no `any`). GREEN + typecheck + `npx vitest run tests/renderers/sdk-golden.test.ts` (unwired — must stay green).
- [ ] **Step 3: Commit** (own files, retry protocol): `feat(mcp): catalog computation + emitter`

### Task 4 (Wave 2): Protocol emitter

**Files:**
- Create: `src/sdk-plugins/mcp-protocol.ts`
- Test: `tests/sdk-plugins/mcp-protocol.test.ts`

`generateMcpProtocolModule(): string` — STATIC emission (no parameters). Emitted module contract:
- The S1 ambient declaration block (from the spike outcome section) at the top.
- `export interface JsonRpcRequest/JsonRpcResponse` types (id: number|string|null, jsonrpc "2.0").
- `export function runStdioServer(handler: (msg: JsonRpcRequest) => Promise<JsonRpcResponse | null>): void` — reads stdin via `data` events, splits on newlines (buffering partial lines), JSON.parse per line; parse failure → `-32700` response; handler returning null → no response (notifications); writes `JSON.stringify(response) + "\n"` to stdout; NOTHING else ever writes stdout (diagnostics → stderr).
- `export function makeProtocolHandler(tools, callTool): (msg) => Promise<JsonRpcResponse | null>` — implements: `initialize` (protocolVersion constant + `capabilities: { tools: {} }` + serverInfo from injected name/version), `notifications/initialized` → null, `ping` → `{}`, `tools/list` → injected tool definitions, `tools/call` → delegates to `callTool(name, args)` wrapping the result in `{ content: [{ type: "text", text }], isError? }`, unknown method → `-32601`, invalid params shape → `-32602`.
- Emitted file <300 lines; fully erasable TS (S1 rule); import specifiers per the S1 rule.

- [ ] **Step 1: Failing tests** — source assertions for every contract point + runtime tests via the transpile-execute harness pattern (`typescript.transpileModule` + Function wrapper, as in `tests/sdk-plugins/pagination.test.ts`): feed `makeProtocolHandler` a scripted conversation (initialize → initialized → tools/list → tools/call → ping → unknown method → malformed input handled at runStdioServer level is source-asserted only) and assert exact JSON-RPC shapes. RED.
- [ ] **Step 2: Implement.** GREEN + typecheck + golden lock (unwired) green.
- [ ] **Step 3: Commit** (own files, retry protocol): `feat(mcp): zero-dep stdio JSON-RPC protocol emitter`

> **Wave-2 boundary (controller):** full suite + typecheck; Wave-2 reviews in parallel; then Wave 3.

### Task 5 (Wave 3): Gateway emitter

**Files:**
- Create: `src/sdk-plugins/mcp-server.ts` (+ `src/sdk-plugins/mcp-server-emit.ts` sibling if >300 lines — follow the auth/auth-emit precedent)
- Test: `tests/sdk-plugins/mcp-server.test.ts`

`generateMcpServerModule(opts: { productName: string; envPrefix: string; baseUrl: string | null; pkgVersion: string }): string`. Emitted module contract:
- Imports: `CATALOG` from `./mcp-catalog.js`-style specifier (S1 rule), protocol module exports, `Client`/`attachResources` from the SDK, `resolveAuthFromEnv` not needed directly (Client handles env pickup).
- `export interface GatewayDeps { readonly fetchImpl?: typeof fetch; readonly env?: Record<string, string | undefined>; }`
- `export function createGateway(deps?: GatewayDeps)` returning the protocol handler via `makeProtocolHandler(TOOLS, callTool)`.
- THREE tool definitions with JSON Schemas: `search_operations { query: string (required), limit?: integer 1-25 }`; `describe_operation { id: string (required) }`; `invoke_operation { id: string (required), args?: object, confirm?: boolean }`.
- **search**: tokenize query (lowercase, split non-alphanumeric, drop empties); score = sum over tokens of (4 if token ∈ id-tokens, 3 if ∈ summary, 2 if ∈ path, 1 if ∈ description — match against `searchText` segments; whole-token match); stable sort (score desc, id asc); default limit 10, max 25; result lines `id — METHOD path — summary` + ` [destructive]` suffix when flagged; zero matches → non-error text naming up to 5 example ids.
- **describe**: full entry rendering — params table, annotations, `paginated` note ("pass cursor/offset params; the SDK exposes a *Pages helper"), auth env vars (interpolate the literal names from envPrefix + declared schemes — baked at generation), `confirm: true` requirement statement when destructive, baseUrl note when baked default is null (names `<PREFIX>_BASE_URL`). Unknown id → isError + 3 closest ids via the same scorer over the id.
- **invoke**: resolve entry (unknown → as above); destructive gate — `entry.annotations.destructive && confirm !== true && deps.env?.["<PREFIX>_MCP_ALLOW_DESTRUCTIVE"] !== "1"` → isError `destructive_confirmation_required` with exact re-invoke instruction; baseUrl = `env["<PREFIX>_BASE_URL"] ?? <baked> ?? null` — null → isError naming the env var; LAZY client: construct `attachResources(new Client({ baseUrl, fetch: deps.fetchImpl, ... }))` on first invoke and cache (auth omitted → SDK env pickup; ConfigError surfaces as isError text); route args by declared `in` (path → pathParams, query → query, body → body); call the accessor; success → `JSON.stringify(result, null, 2)` truncated at 50_000 bytes with `\n…[truncated]` notice; SDK errors → isError with name + message (Spec A guarantees no secrets).
- `main()` + `if (isMain())`-style entry calling `runStdioServer(createGateway())` — guarded so importing the module in tests does NOT start the stdio loop (S1 determines the mechanism: `import.meta.main` is not available — use an env/argv guard or export `main` and let bin invoke it; pick per S1 and document).
- Emitted file <300 lines (split emitted gateway helpers into the same module carefully; if emitted size for a 4-op fixture exceeds, restructure emission — report).

- [ ] **Step 1: Failing tests** — source assertions (tool schemas, gate condition, lazy construction, truncation constant) + runtime tests via transpile-execute: stub `./mcp-catalog.js` and SDK imports with a tiny in-harness module map (the harness's `require` shim returns fixtures), then drive `createGateway` handler end-to-end: search determinism + weighting (id beats description), describe env-var names, gate refusal text → confirm → invoke calls fake accessor, env override skips gate, unknown-id suggestions, truncation. RED.
- [ ] **Step 2: Implement.** GREEN + typecheck + golden lock (unwired) green.
- [ ] **Step 3: Commit**: `feat(mcp): gateway emitter — search/describe/invoke with confirm gate`

### Task 6 (Wave 4): Big-bang wiring — emission, launcher, .mcp.json, templating, --skip-mcp, golden regen

**Files:**
- Modify: `src/renderers/sdk.ts` (emit `src/mcp-catalog.ts`/`mcp-protocol.ts`/`mcp-server.ts` + `bin/mcp.js` unless `input.skipMcp`; catalog computed beside `computeWedgeInputs`)
- Modify: `src/renderers/sdk-templates/render.ts` + `package.json.tpl` (conditional `bin` entry `{ "<product>-mcp": "bin/mcp.js" }`) + `README.md.tpl` (conditional "Use with Claude Code" section: .mcp.json snippet + env table reference)
- Modify: `src/cli/index.ts` + `src/cli/build.ts` (`--skip-mcp` boolean threaded to `RenderSdkInput.skipMcp`)
- Modify: `src/renderers/mcpJson.ts` (when MCP emitted: add `"<productId>": { "command": "node", "args": ["sdk/bin/mcp.js"] }` — RELATIVE path from the `.mcp.json` location; existing vendor entries unchanged)
- Create (emitted into trees): `bin/mcp.js` with the EXACT S1 launcher text
- Regenerate: all 3 TS golden trees; extend `tests/renderers/sdk-golden.test.ts` if the tree file-list assertions need the new files
- Test: extend `tests/renderers/sdk-templates.test.ts` (conditional sections), `tests/renderers/mcpJson.test.ts` (new entry + skip case), new `tests/renderers/sdk-skip-mcp.test.ts` (render with `skipMcp: true` → tree contains NO mcp files, NO bin, package.json has no bin key, README has no MCP section — byte-equivalent to pre-T6 content shape)

- [ ] **Step 1: Failing unit tests first** (templating conditionals, mcpJson entry, skip-mcp absence assertions). RED.
- [ ] **Step 2: Implement wiring** (emission + launcher + flag + mcpJson). Golden lock now RED — expected, confined to this task.
- [ ] **Step 3: Regenerate all 3 TS trees** (`npx tsx scripts/gen-sdk-goldens.mts`); review by category and report: every tree gains the 3 mcp modules + bin/mcp.js + package.json bin + README section; agent tree's catalog carries the annotated POST (destructive true), baked baseUrl, 4 entries. Emitted files <300 lines each. Re-lock; tsc gates green (S1 ambient block proves out here).
- [ ] **Step 4: Full verification** — unit + golden + typecheck + full suite exit 0.
- [ ] **Step 5: Commit**: `feat(mcp): emit MCP server into SDK package — wiring, launcher, .mcp.json, --skip-mcp`

### Task 7 (Wave 5): Behavioral + smoke suites

**Files:**
- Create: `tests/renderers/mcp-server-behavior.test.ts` — imports the COMMITTED agent golden's generated modules in-process (vitest TS resolution, as `sdk-runtime-behavior.test.ts` does); drives full JSON-RPC conversations through `createGateway` with fake fetch/env: (1) initialize/initialized/ping shapes; (2) tools/list schemas exact; (3) search determinism (two identical calls → byte-identical) + weighting pin (id match outranks description match) + limit clamp; (4) describe: env var names (`AGENTMIN_CLIENT_ID`...), confirm requirement on the annotated op, pagination note on `items_list`; (5) invoke happy path: oauth2 token fetch + Bearer on the API call observed via fake fetch (PROOF the real SDK runtime is in the loop); (6) gate: refusal text → `confirm: true` → executes; `AGENTMIN_MCP_ALLOW_DESTRUCTIVE=1` skips; (7) missing creds → isError naming env vars; (8) unknown id → 3 suggestions; (9) truncation over 50KB; (10) baseUrl env override respected.
- Create: `tests/renderers/mcp-server-smoke.test.ts` — spawns the committed golden's `bin/mcp.js` (child_process, current Node), real stdio: initialize → tools/list → clean shutdown on stdin end; no network; S1 `skipIf` guard; 30s timeout.

- [ ] Steps: RED (suite files fail on missing assertions vs committed goldens? — these test committed artifacts: write tests, run, they must PASS against T6's goldens; any failure = fix the EMITTER (a T3-T6 file), regenerate, re-lock — never the golden). Run both suites + full suite, exit 0. Commit: `test(mcp): behavioral gateway suite + stdio process smoke`

### Task 8 (Wave 5): KNOWN_GAPS, docs, CI

**Files:**
- Modify: `KNOWN_GAPS.md` — section "MCP server renderer (2026-06-10)": protocol-subset conformance is owned in-repo (no upstream SDK); Node floor for the no-build flow = S1 outcome (older Node → actionable error; `npm run build` path exists); annotation coverage heuristic when the graph has no claims; 50KB response truncation; npm-publish posture (`.npmignore` excludes src/ — published bin can't re-exec TS source; publishing out of scope); future work: `servers`-block projection into the synthetic OAS (would serve Fern environments too), named body params (request-body projection), search over enriched descriptions.
- Modify: `docs/ARCHITECTURE.md` (renderer/emitter list), spec status header → Implemented.
- Modify: `.github/workflows/` — main CI already runs the full suite (new tests ride along); `sdk-docker.yml` `pull_request.paths` gains `src/sdk-plugins/mcp-*.ts` ONLY IF they affect Fern inputs (they don't — but `src/renderers/fern-oas-rewrite.ts` was touched in T1 and is ALREADY in the paths; verify, don't duplicate). Smoke-test consideration: `tests/renderers/mcp-server-smoke.test.ts` runs in main CI — confirm the runner's Node version ≥ S1 floor (read `.github/workflows/ci.yml` node-version; if below floor, bump it and note in the report).

- [ ] Steps: implement → full verification (typecheck/test/build exit 0) → commit: `docs+ci: MCP server gaps, architecture, CI node floor`

---

## Success criteria (from spec §6 — final review checks all)
1. Process smoke green (handshake over real stdio, no build step).
2. `.mcp.json` carries the generated-server entry with a relative path.
3. Behavioral suite proves search determinism/weighting, describe truthfulness, REAL SDK reuse (auth header via fake fetch), gate semantics + env override.
4. All 3 TS trees regenerated once, locked, tsc-gated; Fern goldens untouched (T1 strips the extension).
5. `--skip-mcp` tree contains no MCP artifacts (asserted).
6. Full suite/typecheck/build exit 0.
7. KNOWN_GAPS complete per T8.
