# MCP Server Renderer (R-MCP) — Design (Spec B)

**Date:** 2026-06-10
**Status:** Approved design, pre-plan
**Repo:** skillship
**Predecessor:** Spec A — agent-ready SDK runtime (implemented 2026-06-10; this spec wraps it)

## 1. Goal

Every `skillship build` emits a working MCP server for the product, inside the
generated TypeScript SDK package, so that an agent client (Claude Code, Cursor)
connects via the emitted `.mcp.json` and can discover and invoke the product's
API — completing the SLC statement: **"one command and your product works in
Claude Code/Cursor in under ten minutes, even from docs-only input."**

## 2. Locked decisions (user-approved 2026-06-10)

1. **Gateway architecture** (from the MVP scoping session): exactly THREE fixed
   tools — `search_operations`, `describe_operation`, `invoke_operation` —
   wrapping the generated TS SDK. Constant context cost regardless of API size.
2. **Packaging:** inside the SDK package. New generated modules
   `src/mcp-catalog.ts`, `src/mcp-protocol.ts`, `src/mcp-server.ts` + `bin/mcp.js`
   + a `bin` entry in the generated package.json. No second package.
3. **Protocol:** zero-dependency hand-rolled stdio JSON-RPC implementing the MCP
   subset the gateway needs (`initialize`, `notifications/initialized`,
   `tools/list`, `tools/call`, `ping`). Newline-delimited JSON-RPC 2.0; unknown
   methods → `-32601`. No `@modelcontextprotocol/sdk` dependency.
4. **Safety:** confirm-flag gate. Destructive operations require
   `confirm: true` in `invoke_operation` args; without it the server returns a
   structured refusal instructing the agent to confirm.
   `<PREFIX>_MCP_ALLOW_DESTRUCTIVE=1` disables the gate.
5. **Emission:** default ON whenever the TS SDK is emitted; new `--skip-mcp`
   flag opts out. `--skip-sdk` implies no MCP server.

## 3. Current state (verified anchors, post-Spec-A)

- The generated SDK (Spec A) ships: `AuthConfig` with env auto-pickup
  (`resolveAuthFromEnv`, `REQUIRED_ENV_VARS`), oauth2 client-credentials with
  cache/single-flight, retries with Retry-After, `*Pages()` pagination, typed
  errors incl. `ConfigError` naming env vars. The MCP server reuses ALL of it by
  calling through the SDK's resources/runtime.
- `src/renderers/sdk.ts` orchestrates emission via `computeWedgeInputs`
  (schemes, plans, envPrefix, retries) + `writeWedgeModules`; golden trees are
  byte-locked with tsc gates (`tests/renderers/sdk-golden.test.ts`); behavioral
  tests execute committed golden sources (`tests/renderers/sdk-runtime-behavior.test.ts`).
- `src/renderers/mcpJson.ts` emits `.mcp.json` listing vendors' EXISTING MCP
  surfaces (`type: "http"` entries). It does not reference generated servers.
- Operation nodes in the graph carry `is_destructive` / `is_read_only` /
  `is_idempotent` claims (`src/graph/types.ts:91-107`; populated by the zodAst
  extractor and the optional LLM enrich stage). **The synthetic OAS does NOT
  project them** — the SDK pipeline (which sees only `oasJson` + overlay) cannot
  read them today. This is the same severed-chain pattern Spec A hit twice
  (flows, response schemas); §4.2 closes it up front.
- `resolveAssignments` (resource-tree) is the single naming pass; `detectPagination`
  the single pagination pass; `extractAuthSchemes` the single auth pass — the
  catalog derives from these same sources so nothing can drift.
- Generated packages are TypeScript SOURCE (no dist/ committed); Node engine
  floor is ≥20. `node bin/mcp.js` must work without an install/build step —
  see spike S1 (§7).

## 4. Design

### 4.1 Generated artifacts (per product, inside `sdk/`)

```
sdk/
  src/
    mcp-catalog.ts    # operation index baked as literals (search/describe data)
    mcp-protocol.ts   # zero-dep stdio JSON-RPC loop (MCP subset)
    mcp-server.ts     # gateway: 3 tool defs + handlers; pure handleMessage core
  bin/mcp.js          # launcher (mechanism = spike S1 outcome)
  package.json        # gains "bin": { "<product>-mcp": "bin/mcp.js" }
```

Emitters (our source, mirroring Spec A patterns — pure string emission, source
assertions + golden lock + behavioral suite):

```
src/sdk-plugins/mcp-catalog.ts    # generateMcpCatalogModule(entries): string
src/sdk-plugins/mcp-protocol.ts   # generateMcpProtocolModule(): string (static)
src/sdk-plugins/mcp-server.ts     # generateMcpServerModule(productName, envPrefix): string
```

House rules apply to both levels (≤300-line files, ≤50-line functions, no `any`,
explicit return types); split `*-emit.ts` siblings as in Spec A when needed.

### 4.2 Annotation projection (chain-gap closure, do FIRST)

`src/renderers/oas.ts` projects the graph's operation annotation claims into
each synthetic-OAS operation as a vendor extension:

```json
"x-skillship-annotations": { "destructive": true, "readOnly": false, "idempotent": false }
```

Only claims that EXIST are projected (absent claims → key omitted — no guessing
at the OAS layer). Existing fixtures have no annotation claims, so existing OAS
goldens stay byte-identical (the extension only appears when claims exist; if a
fixture needs one for testing, the agent fixture gains an annotated op).
The catalog computation reads the extension; where absent it falls back to the
HTTP-method heuristic at CATALOG level: GET/HEAD → readOnly, DELETE →
destructive, everything else → plain write (neither flag).

### 4.3 The catalog (`mcp-catalog.ts`, generated)

One literal array, computed at generation time from the SAME passes the SDK
uses (`extractOperations` + `resolveAssignments` + `detectPagination` +
`extractAuthSchemes` + the OAS doc):

```ts
export interface CatalogEntry {
  readonly id: string;            // public op id: "<namespace>_<method>" snake_case
  readonly accessor: readonly [string, string]; // [namespace, methodName] on attachResources(client)
  readonly httpMethod: string;
  readonly path: string;
  readonly summary: string;       // "" when absent
  readonly description: string;   // "" when absent
  readonly params: readonly CatalogParam[]; // name, in: path|query|body, type, required
  readonly annotations: { readonly destructive: boolean; readonly readOnly: boolean; readonly idempotent: boolean };
  readonly paginated: boolean;    // a *Pages variant exists
}
```

`id` uses the same `snake(namespace)_snake(methodName)` convention as the Fern
rewrite, so the names an agent sees through MCP match the Python/Rust SDK
method names. Params derive from the synthetic OAS operation (path/query
params + body presence; body params from the OAS requestBody where present,
else a single `body` object param). Search text fields are pre-lowercased at
generation time for deterministic matching.

### 4.4 The protocol module (`mcp-protocol.ts`, generated, static)

- Reads stdin as newline-delimited JSON-RPC 2.0; writes responses to stdout;
  logs nothing to stdout except protocol frames (diagnostics → stderr).
- `initialize` → declares `protocolVersion` (the latest spec revision the
  gateway conforms to, baked as a constant), `capabilities: { tools: {} }`,
  `serverInfo { name: "<product>-mcp", version: <pkg version> }`. Accepts the
  client's requested version per MCP version-negotiation rules (respond with
  our version; the client disconnects if incompatible).
- `notifications/initialized` → no response. `ping` → `{}` result.
- `tools/list` → the three tool definitions with JSON Schemas.
- `tools/call` → dispatch to the gateway; tool results use the MCP shape
  `{ content: [{ type: "text", text: ... }], isError?: true }`.
- Unknown method → JSON-RPC error `-32601`; parse failure → `-32700`;
  invalid params → `-32602`.
- Module exposes `runStdioServer(handler)` and keeps ALL protocol I/O separate
  from gateway logic.

### 4.5 The gateway (`mcp-server.ts`, generated)

Pure core, injectable for tests:

```ts
export interface GatewayDeps { readonly fetchImpl?: typeof fetch; readonly env?: Record<string, string | undefined>; }
export function createGateway(deps?: GatewayDeps): (msg: JsonRpcRequest) => Promise<JsonRpcResponse>;
```

- **`search_operations(query: string, limit?: number)`** — tokenizes the query
  (lowercase, split on non-alphanumerics), scores each catalog entry with fixed
  field weights (id 4, summary 3, path 2, description 1; whole-token match
  required), stable sort by (score desc, id asc), returns top `limit` (default
  10, max 25) as compact text lines: `id — METHOD path — summary [destructive]`.
  Zero matches → a helpful result naming a few example ids (not an error).
- **`describe_operation(id: string)`** — full entry: params with types and
  required flags, annotations, pagination availability (and that `invoke`
  auto-iterates is NOT offered — pagination surfaces as "pass cursor/offset
  params; a `*Pages` helper exists in the SDK"), auth requirement: which env
  vars must be set (from `REQUIRED_ENV_VARS`), and whether `confirm: true` is
  required. Unknown id → isError result with 3 closest ids (by the same scorer).
- **`invoke_operation(id: string, args?: object, confirm?: boolean)`** —
  resolves the entry; destructive gate (entry.annotations.destructive) requires
  `confirm === true` unless `env["<PREFIX>_MCP_ALLOW_DESTRUCTIVE"] === "1"`;
  refusal is a structured isError result with the exact re-invoke instruction.
  Lazily constructs the SDK client ON FIRST INVOKE (`new Client({ baseUrl, ... })`
  + `attachResources`) using env auto-pickup; missing credentials surface the
  SDK's `ConfigError` (which names the env vars) as an isError result.
  `args` maps to the accessor's expected shape ({ pathParams, query, body } per
  the catalog params; the gateway routes each arg by its declared `in`).
  Success → response JSON pretty-printed as text content (truncated at a fixed
  byte budget, default 50 KB, with a truncation notice). SDK typed errors
  (status, message, attempt counts) → isError text; secrets never echoed
  (guaranteed by Spec A's error contracts).
- **baseUrl** resolution: baked default from the synthetic OAS/product config
  at generation time; `<PREFIX>_BASE_URL` env override.

### 4.6 Launcher + `.mcp.json`

- `bin/mcp.js`: mechanism decided by spike S1. Requirement: `node bin/mcp.js`
  starts the server on Node ≥22.6 with no install/build step (native type
  stripping); on older Node it prints ONE actionable line to stderr (exact
  message in the plan) and exits 1. The candidate is a small JS shim that
  re-execs `node --experimental-strip-types src/mcp-server.ts` (or relies on
  default stripping on ≥23), verified by the spike across the supported matrix.
- `src/renderers/mcpJson.ts` extends: when the MCP server was emitted, add
  `"<productId>": { "command": "node", "args": ["<relative path>/sdk/bin/mcp.js"] }`
  alongside existing vendor-surface entries. Paths are relative to the
  `.mcp.json` location (portable output directory).
- Generated README gains an "Use with Claude Code" section: the `.mcp.json`
  snippet + the env vars to set (same derived table as Spec A's auth section).

### 4.7 Wiring + CLI

- `src/renderers/sdk.ts`: `renderSdkPackage` emits the MCP modules unless
  `input.skipMcp`; the catalog computation lives beside `computeWedgeInputs`.
- `src/cli/build.ts` + `src/cli/index.ts`: `--skip-mcp` flag (boolean,
  compatible with everything; meaningless with `--skip-sdk` which already
  implies it — no error, just no-op).
- Existing TS golden trees regenerate ONCE (they gain the three modules +
  bin + package.json bin entry + README section). Fern path untouched.

### 4.8 Error handling summary

| Failure | Behavior |
|---|---|
| Unknown tool name in tools/call | isError result naming the three tools |
| Unknown operation id | isError + 3 closest ids |
| Destructive without confirm | isError `destructive_confirmation_required` + re-invoke instruction |
| Missing credentials at invoke | SDK ConfigError surfaced as isError, naming env vars |
| Upstream API error | typed SDK error → isError text (status + message, post-retries) |
| Malformed JSON-RPC frame | `-32700`; invalid params `-32602`; unknown method `-32601` |
| Oversized response | truncated at byte budget with explicit notice |
| stdout pollution | impossible by construction — only the protocol module writes stdout |

### 4.9 Testing

- **Emitter unit tests** (source assertions, Spec A style) per module.
- **Behavioral suite** (`tests/renderers/mcp-server-behavior.test.ts`):
  imports the committed agent-golden's generated modules in-process; drives
  `createGateway` + the protocol handler with full JSON-RPC conversations and
  fake fetch/env: handshake shape, tools/list schemas, search determinism
  (same query → byte-identical results; weighting pins), describe truthfulness
  (env vars, confirm requirement), confirm-gate refusal → confirm → invoke
  succeeds against fake fetch (auth header present — proving SDK reuse),
  env-override disables gate, unknown-id suggestions, error mapping, truncation.
- **Process smoke test**: spawns the committed golden's `bin/mcp.js` (current
  Node, no network), performs initialize → tools/list → shutdown over real
  stdio; skipIf for Node < spike-determined floor.
- **Golden lock + tsc gates**: regenerated trees re-locked; the new modules
  typecheck under the existing gate.
- Determinism: generation-time only (catalog literals); search scoring is pure.

## 5. Explicitly NOT in scope

HTTP/SSE transport; MCP resources/prompts/sampling capabilities; code-mode
(execute-arbitrary-TS) tools; multi-product servers; auto-pagination inside
invoke; publishing/registry automation; Python/Rust MCP servers; tool-per-operation
mode; rate limiting beyond the SDK's retries.

## 6. Success criteria

1. `skillship build` against the agent fixture emits an SDK whose `bin/mcp.js`
   starts and completes the MCP handshake over stdio (process smoke test green).
2. `.mcp.json` contains the generated-server entry with a portable relative path.
3. Behavioral suite proves: search is deterministic and weighted as specified;
   describe names the exact env vars and confirm requirement; invoke executes
   through the REAL SDK runtime (auth header + retry behavior observable via
   fake fetch); destructive ops refuse without confirm, succeed with it, and
   the env override works.
4. The three generated modules + bin appear in all TS golden trees (regenerated
   once, reviewed by category, byte-locked, tsc-gated); Fern goldens untouched.
5. `--skip-mcp` produces a tree byte-identical to today's (minus nothing) —
   asserted by a render-level test.
6. Full suite green (`npm test` exit 0), typecheck green, build green.
7. KNOWN_GAPS records: protocol-subset conformance ownership, Node-version
   floor for the no-build flow (spike S1 outcome), annotation coverage
   (heuristic fallback when the graph has no claims), response truncation.

## 7. Plan-phase spike (sequence FIRST, fold outcome into the plan)

- **S1 — no-build launcher mechanism.** On this machine (Node 24) and against
  the documented behavior of Node 20/22.6+/23+: determine the exact `bin/mcp.js`
  contents that (a) run the TS server with native type stripping where
  available, (b) fail with one actionable stderr line on unsupported Node,
  (c) require zero installs. Verify the generated module set is fully
  "erasable TS" (no enums/parameter-properties/namespaces — strip-types-safe);
  if any Spec A generated module violates erasability, the spike reports it
  and the plan adds the minimal emitter fix. Outcome: exact launcher text +
  the documented Node floor + a `skipIf` guard expression for the smoke test.
