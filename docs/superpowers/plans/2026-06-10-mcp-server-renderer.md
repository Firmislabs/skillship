# MCP Server Renderer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `skillship build` emits a working zero-dependency MCP server (gateway: `search_operations`/`describe_operation`/`invoke_operation`) inside the generated TS SDK package, wired into `.mcp.json`, so the product works in Claude Code/Cursor with no install step.

**Architecture:** Three new generated modules inside the SDK package (`mcp-catalog.ts` — literal operation index; `mcp-protocol.ts` — stdio JSON-RPC subset; `mcp-server.ts` — gateway with pure `handleMessage` core) + `bin/mcp.js` launcher. Catalog derives from the SAME passes as the SDK (`extractOperations`/`resolveAssignments`/`detectPagination`/`extractAuthSchemes`), so names cannot drift. Two chain closures land first: annotation ingestion/projection and baseUrl plumbing. Spec: `docs/superpowers/specs/2026-06-10-mcp-server-renderer-design.md`.

**Tech Stack:** TypeScript (Node ≥20 repo; generated MCP entry requires the spike-determined Node floor), vitest, existing golden/manifest/tsc-gate infrastructure, zero new dependencies anywhere.

**Worktree:** `/Users/riteshkewlani/github/skillship/.worktrees/mcp-server`, branch `mcp-server-renderer`.

---

## Spike S1 outcome (verified 2026-06-10 on Node 24.11.0 + official Node docs)

**Type-stripping matrix:** `--experimental-strip-types` since 22.6; default-on since 23.6 (22.18 backport); warning removed 24.3; stable naming 24.12. **Node floor for the no-build flow: ≥ 23.6.0.** Below it, `.ts` files raise `SyntaxError` (no TS awareness on 20).

**Erasability:** ALL committed golden SDK sources are fully erasable (no enums/namespaces/parameter-properties/decorators/`import =`). No Spec A emitter changes needed for erasability.

**THE HARD FINDING — import specifiers:** Node's ESM resolver does NOT map `.js` specifiers to `.ts` files. **S1b VERDICT (verified end-to-end with real golden SDK files — errors/runtime/auth chain loaded, ping round-trip, exit 0): file-based loader hook.** ALL generated modules (SDK and MCP alike) keep standard `.js` specifiers; the launcher registers a 22-line zero-dep resolve hook (`bin/loader.mjs` via `module.register("./loader.mjs", import.meta.url)`) that rewrites a relative `.js` specifier to `.ts` ONLY when the `.js` file is absent and the `.ts` sibling exists — it cannot intercept `node:*`/bare/absolute/`data:` specifiers and cannot shadow a genuine `.js` file. Golden tsconfig UNCHANGED (the `.js`-specifier sources pass the existing gate with zero modifications; `allowImportingTsExtensions` is NOT needed). ~20ms hooks-thread startup cost (70ms total), irrelevant for a long-lived stdio server. Edge checks all green incl. cwd-independence and no-stdin clean exit. Tasks 4/5/6 consume the verified launcher + loader text below.

**Verified `bin/loader.mjs` (T6 emits exactly this):**

```js
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
    return nextResolve(specifier, context);
  }
  const resolved = new URL(specifier, context.parentURL ?? import.meta.url);
  const jsPath = fileURLToPath(resolved);
  if (!existsSync(jsPath)) {
    const tsPath = jsPath.replace(/\.js$/, ".ts");
    if (existsSync(tsPath)) {
      return nextResolve(specifier.replace(/\.js$/, ".ts"), context);
    }
  }
  return nextResolve(specifier, context);
}
```

**Verified `bin/mcp.js` shape (T6 emits this, minus the data-URL alternate):** version gate (floor 23.6, actionable stderr, exit 1) → `register("./loader.mjs", import.meta.url)` → import the entry. **SUPERSEDED BY T5's architecture:** the emitted `mcp-server.ts` does NOT auto-start at import (tests import it cleanly), so the launcher's final lines are `const mod = await import(new URL("../src/mcp-server.ts", import.meta.url).href); mod.main();` — the spike's bare-import shape applied only to the spike scaffold. `bin/loader.mjs` remains byte-verbatim.

**Launcher skeleton (verified, mechanism-independent parts):** `#!/usr/bin/env node` JS file in a `"type":"module"` package; version gate comparing `process.versions.node` against 23.6 with an actionable 3-line stderr message + exit 1; entry via `await import(new URL("../src/mcp-server.ts", import.meta.url).href)` (cwd-independent); `echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | node bin/mcp.js` round-trips.

**Ambient block for the tsc gate (verified — typechecks under the golden DOM-lib strict config AND runs under stripping):**

```ts
declare const process: {
  stdin: {
    setEncoding(enc: string): void;
    on(event: "data", listener: (chunk: string) => void): void;
    on(event: "end", listener: () => void): void;
    resume(): void;
  };
  stdout: { write(data: string): boolean };
  exit(code: number): never;
  versions: { node: string };
};
```

(Place in the emitted protocol module; extend minimally if the gateway needs more — e.g. `env` is already declared in auth.ts's narrow ambient; avoid duplicate `declare const process` in ONE compilation — the protocol module owns the wide declaration and other MCP modules import nothing process-related, OR unify into a shared emitted `mcp-ambient.d.ts`-style block; decide in T4 and keep tsc green.)

**skipIf guard for the smoke test (verified form):**

```ts
const BELOW_STRIP_FLOOR = (() => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major < 23 || (major === 23 && minor < 6);
})();
describe.skipIf(BELOW_STRIP_FLOOR)("MCP stdio smoke", () => { /* ... */ });
```

**Watch-outs:** disable-flag is `--no-experimental-strip-types` on ≤24.11, `--no-strip-types` on ≥24.12 (irrelevant to us, recorded); CI `ci.yml` node-version must be ≥23.6 for the smoke test or it self-skips (T8 verifies).

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

**Concurrent-commit protocol (MANDATORY for same-wave implementers):** stage ONLY your task's listed files by exact path (never `git add -A`); if `git commit` fails with an index.lock error, retry up to 5 times with `sleep 2` between attempts.

**Concurrent-verification protocol (MANDATORY — the file map is write-disjoint but NOT read-disjoint):** within a task, run ONLY your own test files (the ones in your Files list) for RED/GREEN — never the golden lock, never a project-wide `tsc --noEmit`, never the full suite, never any test that imports another wave-mate's in-flight files. ALL cross-file proofs (golden-lock runs, project typecheck, full suite, byte-stability claims) happen at the WAVE BOUNDARY, run once by the controller after every wave commit has landed — and STOP-if-red semantics apply to THOSE boundary runs only. If your own targeted test unexpectedly touches a wave-mate's file (e.g. ingesting a fixture they edit), say so in your report instead of debugging phantom failures.

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
- [ ] **Step 3: Failing OAS-renderer tests.** Graph op with `is_destructive: true` claim → synthetic-OAS operation carries `"x-skillship-annotations": { "destructive": true }` (only the keys whose claims exist — no defaults at this layer); no claims → no extension key. RED → implement in the op-emission path (read claims like siblings) → GREEN. `oas.ts` is at 277 lines — if the projection pushes it past 300, extract the helper into a sibling module (follow the shared/oas-schema.ts precedent).
- [ ] **Step 4: Failing Fern-strip test.** `buildFernOas` output contains NO `x-skillship-annotations` anywhere even when the input does (internal extension; keeps Fern input byte-stable so the nightly Docker lane cannot drift). RED → implement (delete during the existing per-op rewrite pass) → GREEN.
- [ ] **Step 5: Fixture.** Add to `POST /items` in `agent-minimal.yaml`: `x-skillship-annotations: { destructive: true }`. End-to-end pin: ingest fixture → render synthetic OAS → the POST op carries the extension (real pipeline, no hand-built docs — extend the existing e2e pattern from `tests/renderers/pagination-detect-e2e.test.ts`).
- [ ] **Step 6: Commit** (own files only, index.lock retry protocol): `feat(oas): annotation chain — x-skillship-annotations ingest + project + Fern strip`

> **Wave-boundary proof (CONTROLLER runs this, not the T1 implementer):** `npx vitest run tests/renderers/oas-golden.test.ts tests/renderers/sdk-golden.test.ts tests/renderers/sdk-fern-golden.test.ts` → ALL PASS: existing fixtures carry no extensions (OAS goldens byte-stable); the agent fixture's synthetic OAS changes but hey-api ignores unknown op-level extensions so the rendered TS tree must be byte-identical — if the TS golden lock goes red AT THE BOUNDARY, the controller stops the wave and investigates with the diff (no regeneration); Fern goldens unaffected (strip + manifest check green).

### Task 2 (Wave 1): baseUrl plumbing

**Files:**
- Modify: `src/cli/build.ts` (read in `runBuild`/`writeAll` scope where `handle.db` lives; NEVER pass db into the SDK renderer)
- Modify: `src/renderers/sdk.ts` (`RenderSdkInput` gains `baseUrl: string | null`; stored on wedge inputs, UNUSED by emitters until T6 — rendered output must not change)
- Test: extend the existing build test file (`grep -rl "assembleSdkArtifacts\|runBuild" tests/cli/`) + a unit test on the claim read

- [ ] **Step 1: Failing test.** Unit-level on the helper ONLY (do NOT ingest `agent-minimal.yaml` — T1 edits it concurrently this wave): seed a minimal in-memory graph (or a tiny inline spec string) with a REST surface carrying a `base_url` claim → `readRestBaseUrl(db, productId)` returns it; absent claim → null. RED.
- [ ] **Step 2: Implement.** `readRestBaseUrl` uses `stableId("sfc", [productId, "rest"])` + `readBestClaim(db, surfaceId, "base_url")` (import what `src/extractors/openapi3.ts:70` and the oas.ts claim-readers already use; if `readBestClaim` isn't exported where needed, export it — note it). Thread through `assembleSdkArtifacts` → `RenderSdkInput`. GREEN.
- [ ] **Step 3: Commit** (own files only, retry protocol): `feat(sdk): plumb REST surface base_url into RenderSdkInput`. Render-invisibility (golden lock byte-identical with baseUrl accepted-but-unused) is proven at the wave boundary by the controller, not here.

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
- `export function makeProtocolHandler(tools, callTool): (msg) => Promise<JsonRpcResponse | null>` — implements: `initialize` (protocolVersion constant + `capabilities: { tools: {} }` + serverInfo from injected name/version), `notifications/initialized` → null, `ping` → `{}`, `tools/list` → injected tool definitions, `tools/call` → if the requested tool name is not in `tools`, return a SUCCESSFUL response whose result is `{ content: [{ type: "text", text: "unknown tool '<name>' — available: search_operations, describe_operation, invoke_operation" }], isError: true }` (spec §4.8 row 1 — names derived from the injected tool list, not hardcoded); otherwise delegate to `callTool(name, args)` wrapping the result in `{ content: [{ type: "text", text }], isError? }`; unknown method → `-32601`, invalid params shape → `-32602`.
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
- `export function main(): void` calling `runStdioServer(createGateway())` — NOT invoked at module top level (importing the module in tests must not start the stdio loop). `bin/mcp.js` invokes it: the launcher's final line becomes `const mod = await import(...); mod.main();` — an explicit, documented deviation from the S1 bare-import shape ("exact S1/S1b text" is byte-verbatim for `bin/loader.mjs` ONLY; the launcher adapts).
- Emitted file <300 lines (split emitted gateway helpers into the same module carefully; if emitted size for a 4-op fixture exceeds, restructure emission — report). **ADJUDICATED DEVIATION (Wave-4 review, controller-approved):** the emitted gateway landed at 366-368 lines and is ACCEPTED — the emitter SOURCE is properly split (emit/dispatch/lit, all ≤300) which serves the budget's reviewability purpose; splitting the EMITTED artifact would add cross-module plumbing to a generated file customers read top-to-bottom. T8 records it in KNOWN_GAPS.

- [ ] **Step 1: Failing tests** — source assertions (tool schemas, gate condition, lazy construction, truncation constant) + runtime tests via transpile-execute: stub `./mcp-catalog.js` and SDK imports with a tiny in-harness module map (the harness's `require` shim returns fixtures), then drive `createGateway` handler end-to-end: search determinism + weighting (id beats description), describe env-var names, gate refusal text → confirm → invoke calls fake accessor, env override skips gate, unknown-id suggestions, truncation. RED.
- [ ] **Step 2: Implement.** GREEN + typecheck + golden lock (unwired) green.
- [ ] **Step 3: Commit**: `feat(mcp): gateway emitter — search/describe/invoke with confirm gate`

### Task 6 (Wave 4): Big-bang wiring — emission, launcher, .mcp.json, templating, --skip-mcp, golden regen

**Files:**
- Modify: `src/renderers/sdk.ts` (emit `src/mcp-catalog.ts`/`mcp-protocol.ts`/`mcp-server.ts` + `bin/mcp.js` unless `input.skipMcp`; catalog computed beside `computeWedgeInputs`)
- Modify: `src/renderers/sdk-templates/render.ts` + `package.json.tpl` (conditional `bin` entry `{ "<product>-mcp": "bin/mcp.js" }`) + `README.md.tpl` (conditional "Use with Claude Code" section: .mcp.json snippet + env table reference)
- Modify: `src/cli/index.ts` + `src/cli/build.ts` (`--skip-mcp` boolean threaded to `RenderSdkInput.skipMcp`)
- Modify: `src/renderers/mcpJson.ts` (when MCP emitted: add `"<productId>": { "command": "node", "args": ["sdk/bin/mcp.js"] }` — RELATIVE path from the `.mcp.json` location; existing vendor entries unchanged). NOTE: `renderMcpJson` runs inside `writeAll` (build.ts:192) BEFORE `assembleSdkArtifacts` — the "when MCP emitted" condition derives from the `skipSdk`/`skipMcp` FLAGS, not from the SDK render result.
- Create (emitted into trees): `bin/mcp.js` + `bin/loader.mjs` with the EXACT S1/S1b verified text (loader byte-verbatim from the spike section)
- Regenerate: all 3 TS golden trees; extend `tests/renderers/sdk-golden.test.ts` if the tree file-list assertions need the new files
- Test: extend `tests/renderers/sdk-templates.test.ts` (conditional sections), `tests/renderers/mcpJson.test.ts` (new entry + skip case), new `tests/renderers/sdk-skip-mcp.test.ts` (render with `skipMcp: true` → tree contains NO mcp files, NO bin, package.json has no bin key, README has no MCP section — byte-equivalent to pre-T6 content shape)

- [ ] **Step 1: Failing unit tests first** (templating conditionals, mcpJson entry, skip-mcp absence assertions). RED.
- [ ] **Step 2: Implement wiring** (emission + launcher + flag + mcpJson). Golden lock now RED — expected, confined to this task.
- [ ] **Step 3: Regenerate all 3 TS trees** (`npx tsx scripts/gen-sdk-goldens.mts`); review by category and report: every tree gains the 3 mcp modules + bin/mcp.js + package.json bin + README section; agent tree's catalog carries the annotated POST (destructive true), baked baseUrl, 4 entries. Emitted files <300 lines each. Re-lock; tsc gates green (S1 ambient block proves out here).
- [ ] **Step 4: Full verification** — unit + golden + typecheck + full suite exit 0.
- [ ] **Step 5: Commit**: `feat(mcp): emit MCP server into SDK package — wiring, launcher, .mcp.json, --skip-mcp`

### Task 7 (Wave 5): Behavioral + smoke suites

**Files:**
- Create: `tests/renderers/mcp-server-behavior.test.ts` — imports the COMMITTED agent golden's generated modules in-process (vitest TS resolution, as `sdk-runtime-behavior.test.ts` does); drives full JSON-RPC conversations through `createGateway` with fake fetch/env: (1) initialize/initialized/ping shapes; (2) tools/list schemas exact; (3) search determinism (two identical calls → byte-identical) + weighting pin (id match outranks description match) + limit clamp; (4) describe: env var names (`AGENTMIN_CLIENT_ID`...), confirm requirement on the annotated op, pagination note on `items_list`; (5) invoke happy path: oauth2 token fetch + Bearer on the API call observed via fake fetch (PROOF the real SDK runtime is in the loop); (6) gate: refusal text → `confirm: true` → executes; `AGENTMIN_MCP_ALLOW_DESTRUCTIVE=1` skips; (7) missing creds → isError naming env vars; (8) unknown id → 3 suggestions; (9) truncation over 50KB; (10) baseUrl env override respected; (11) unknown TOOL name in tools/call → isError naming the three tools (spec §4.8 row 1); (12) retry-through-invoke: fake fetch scripts 429 + `Retry-After: 0` then 200 for an invoke → the retried call succeeds and fake fetch records exactly 2 calls (proves the SDK retry loop is in the invoke path — spec §6.3; `Retry-After: 0` avoids a real sleep since the gateway does not expose the SDK's sleep injection).
- Create: `tests/renderers/mcp-server-smoke.test.ts` — spawns the committed golden's `bin/mcp.js` (child_process, current Node), real stdio: initialize → tools/list → clean shutdown on stdin end; no network; S1 `skipIf` guard; 30s timeout.

- [ ] Steps: these test committed artifacts — write tests, run BOTH OWN SUITES ONLY (concurrent-verification protocol; T8 runs in this wave), they must PASS against T6's goldens; any failure = fix the EMITTER (a T3-T6 file), regenerate, re-lock — never the golden (an emitter fix mid-wave touches files outside this task's list: STOP and report DONE_WITH_CONCERNS naming the emitter bug instead, so the controller sequences the fix after the wave). Commit: `test(mcp): behavioral gateway suite + stdio process smoke`. Full suite runs at the wave-5 boundary (controller).

### Task 8 (Wave 5): KNOWN_GAPS, docs, CI

**Files:**
- Modify: `KNOWN_GAPS.md` — section "MCP server renderer (2026-06-10)": protocol-subset conformance is owned in-repo (no upstream SDK); Node floor for the no-build flow = S1 outcome (older Node → actionable error; `npm run build` path exists); annotation coverage heuristic when the graph has no claims; 50KB response truncation; npm-publish posture (`.npmignore` excludes src/ — published bin can't re-exec TS source; publishing out of scope); future work: `servers`-block projection into the synthetic OAS (would serve Fern environments too), named body params (request-body projection), search over enriched descriptions.
- Modify: `docs/ARCHITECTURE.md` (renderer/emitter list), spec status header → Implemented.
- Modify: `.github/workflows/` — main CI already runs the full suite (new tests ride along); `sdk-docker.yml` `pull_request.paths` gains `src/sdk-plugins/mcp-*.ts` ONLY IF they affect Fern inputs (they don't — but `src/renderers/fern-oas-rewrite.ts` was touched in T1 and is ALREADY in the paths; verify, don't duplicate). Smoke-test consideration: `tests/renderers/mcp-server-smoke.test.ts` runs in main CI — confirm the runner's Node version ≥ S1 floor (read `.github/workflows/ci.yml` node-version; if below floor, bump it and note in the report).

- [ ] Steps: implement → verify ONLY non-test gates that touch own files (lint of YAML by reading; KNOWN_GAPS prose) → commit: `docs+ci: MCP server gaps, architecture, CI node floor`. Full typecheck/test/build run at the wave-5 boundary (controller). CI node floor: both workflows use `node-version-file: .nvmrc` and `.nvmrc` is `20` — do NOT bump `.nvmrc` (it pins the dev/docker lanes); add a job-local `node-version: "24"` override (or a dedicated job) in `ci.yml` for the test job so the smoke test exercises rather than self-skips; state what you did in the report.

---

## Success criteria (from spec §6 — final review checks all)
1. Process smoke green (handshake over real stdio, no build step).
2. `.mcp.json` carries the generated-server entry with a relative path.
3. Behavioral suite proves search determinism/weighting, describe truthfulness, REAL SDK reuse (auth header via fake fetch), gate semantics + env override.
4. All 3 TS trees regenerated once, locked, tsc-gated; Fern goldens untouched (T1 strips the extension).
5. `--skip-mcp` tree contains no MCP artifacts (asserted).
6. Full suite/typecheck/build exit 0.
7. KNOWN_GAPS complete per T8.
