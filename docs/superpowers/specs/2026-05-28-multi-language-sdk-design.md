# Multi-Language SDK — Opt-In Python + Rust via Fern (`--local`)

**Date:** 2026-05-28
**Status:** Draft — pending spec-reviewer + user approval
**Builds on:** `docs/superpowers/specs/2026-05-20-plan-1.5-plus-r-sdk-design.md` (the TypeScript R-SDK wedge). This spec adds Python and Rust as an explicitly opt-in capability; it does not modify the TS path.
**Substrate baseline:** unchanged — this work does not touch the extractor, so `substrate/frozen` is unaffected. The SDK-subsystem tag `r-sdk-wedge/frozen` retags forward when this lands (it exports a new symbol from `resource-tree.ts`).

---

## 1. Context

Skillship is laptop-first and zero-dependency: a `skillship build` renders a skill (SKILL.md, openapi.json, llms.txt, .mcp.json, manifest, references) plus a TypeScript SDK package, all in pure Node with no external runtime. The TS SDK is produced by `renderSdkPackage` (`src/renderers/sdk.ts`), which layers a hand-written wedge (runtime/resources/errors) on `@hey-api/openapi-ts` codegen and gates on `tsc --noEmit`.

Users have asked for Python and Rust SDKs from the same source. Generating idiomatic SDKs for those languages with zero dependencies is not achievable at acceptable quality — the mature, deterministic generators run as Docker images. Validation spikes (recorded in the prior session) established:

- **Fern `--local`** runs each generator as a Docker container, needs **no token/login**, works **offline once images are cached**, and is **byte-deterministic** per pinned image.
- `fern-rust-sdk` (latest `0.36.8`) output passes `cargo check`; `fern-python-sdk` (`5.14.4`) and `fern-typescript-node-sdk` (`3.71.3`) produce nested idiomatic packages.
- All generators parse our OpenAPI **3.1.0** synthetic doc and group operations by `tags`, but name methods from the raw `operationId` (content-addressed `op_<hex>`). The naming intelligence must therefore be applied **on our side** by rewriting `operationId` + `tags` before handing the OAS to Fern.
- **progenitor was disqualified** — it rejects OpenAPI 3.1.0 (`invalid version: 3.1.0`) and we emit 3.1.0.

The architectural insight that keeps this tractable: the **shared engine stays common** (graph → synthetic OpenAPI IR → resource-tree naming); only the **final per-language emission** varies. TS emits via the in-process `@hey-api` wedge; Python/Rust emit via Fern under Docker.

## 2. Locked Decisions (from brainstorming, 2026-05-28)

These are inputs, not open for re-litigation during plan-writing or implementation.

1. **TS stays the zero-dependency default.** `renderSdkPackage` (TS, `@hey-api`, pure Node) is untouched. Python/Rust are an explicitly opt-in capability that **requires Docker** and **fails fast** when Docker is absent.
2. **CLI surface — additive `--sdk <langs>`.** TS remains always-on (still controlled by `--skip-sdk`). `--sdk python,rust` *additionally* emits those via Fern. The TS path is not gated behind `--sdk`.
3. **Output layout — sibling directories.** TS stays exactly at `{outDir}/{product}/sdk/` (byte-identical; existing golden tree + `tsc` gate path untouched). Python/Rust are siblings: `{outDir}/{product}/sdk-python/`, `{outDir}/{product}/sdk-rust/`. Zero migration of today's output.
4. **Test contract — committed goldens + Docker regen lane.** Commit the Python/Rust golden trees. Normal CI byte-compares them with **no Docker** (runs everywhere). A separate **Docker-enabled lane** re-runs Fern and diffs against the committed goldens to catch image drift.
5. **Image pinning — digest-pin + local Docker cache.** Pin generators by immutable `image@sha256:...` digest in a checked-in `generators.yml` so output cannot change unless deliberately bumped. Rely on Docker's local cache for offline use; a one-time `skillship sdk warm` prefetches. No large binaries in git. (If Fern's config only accepts version tags, fall back to exact tag + a recorded digest lockfile.)
6. **Architecture — separate parallel renderer (Approach A).** A new `src/renderers/sdk-fern.ts` is called *after* `renderSdkPackage`; the TS path is provably untouched, all Docker/Fern logic is isolated behind one opt-in module, and naming is shared via an exported assignment function from `resource-tree.ts`.
7. **Opt-in path adds *only* Docker.** It never requires a local Rust or Python toolchain. Generation — and any compile verification — happen inside Fern's generator images or in a toolchain-equipped CI lane, never on the user's laptop at build time.

## 3. Architecture

### 3.1 Module + call site

New module: `src/renderers/sdk-fern.ts`

```ts
export interface RenderFernSdksInput {
  readonly oasJson: string;             // the rendered openapi.json STRING (same type renderSdkPackage takes; NOT mutated)
  readonly productName: string;
  readonly outDir: string;              // the {product} skill dir (sibling of sdk/)
  readonly overlay: CodegenOverlay;
  readonly langs: readonly FernLang[];  // non-empty when called
}
export type FernLang = "python" | "rust";
export interface FernSdkResult {
  readonly emitted: readonly { lang: FernLang; path: string }[];
}
export function renderFernSdks(input: RenderFernSdksInput): Promise<FernSdkResult>;
```

`build.ts` calls it immediately after the existing `renderSdkPackage`, guarded so the entire Docker path is dead code when no Fern languages are requested:

```ts
// ... existing TS SDK emission (unchanged) ...
if (opts.skipSdk !== true) {
  const sdkResult = await renderSdkPackage({ oasJson, productName, outDir: join(skillDir, "sdk"), overlay: codegenOverlay });
  // ...
}
if (fernLangs.length > 0) {
  await renderFernSdks({ oasJson, productName, outDir: skillDir, overlay: codegenOverlay, langs: fernLangs });
}
```

### 3.2 Shared naming engine

`src/sdk-plugins/resource-tree.ts` currently keeps `resolveAssignments(ops, overlay): Assignment[]` **internal**. Promote it (and the `Assignment` type) to a public export. Two consumers then share a single source of truth:

- the existing TS wedge plugin (`generateResourceTreeModule`) — behavior unchanged;
- the new Fern OAS-rewriter.

`renderFernSdks` obtains its `ops: readonly OperationInfo[]` by calling the existing `extractOperations(oasJson)` (`src/renderers/sdk-utils.ts`) — the **same function `renderSdkPackage` calls** (`src/renderers/sdk.ts:79`) — then passes that array to `resolveAssignments(ops, overlay)`. It must **not** re-derive operations from the rewritten temp OAS or hand-roll a parser; doing so would break the invariant below.

**Invariant:** the namespace/method names Fern emits are derived from the *exact same* `extractOperations` → `resolveAssignments` pass that drives the TS SDK. They cannot drift apart.

### 3.3 Data flow

```
graph → synthetic OAS (openapi.json — shipped as-is, never mutated)
              │
              ├─→ renderSdkPackage → sdk/            (TS, @hey-api, pure Node)   [UNCHANGED]
              │
              └─→ renderFernSdks   (only if --sdk given)
                     1. ops = extractOperations(oasJson); resolveAssignments(ops, overlay)   ← shared engine (same call as renderSdkPackage)
                     2. rewrite a TEMP OAS copy:
                          operationId = snake(ns) + "_" + snake(method)
                          tags        = [ns]
                     3. assert Docker daemon reachable (else fail fast)
                     4. scaffold temp Fern project (fern.config.json + generators.yml, digest-pinned)
                     5. fern generate --local                    (Docker)
                     6. atomic move temp outputs → sdk-python/, sdk-rust/
```

## 4. The Naming Lever (OAS rewrite)

`renderFernSdks` **does not mutate** the shipped `openapi.json`. It builds a temp copy and, for each operation, sets:

- `operationId = snake(namespace) + "_" + snake(methodName)` — e.g. `attachments_get_attachments`
- `tags = [namespace]`

Rationale:

1. **Global uniqueness.** Fern requires unique `operationId`s. The `namespace_` prefix guarantees uniqueness; Fern strips the redundant tag prefix when emitting the method, yielding clean grouped names (validated in the spike's "qualified" mode).
2. **Idiomatic casing — the `getattachments` fix.** The spike fed Fern camelCase `getAttachments`; Fern's tokenizer did not split the hump and lowercased it to `getattachments`. Feeding **snake_case** (`get_attachments`) gives clean word boundaries so Fern re-cases idiomatically per language → `get_attachments` (Python/Rust). This requires a small `camelToSnake` helper applied to both the namespace and method components.

**Open verification (resolve in plan via a one-shot spike):** confirm Fern tokenizes a snake_case `operationId` and strips the leading `namespace_` token exactly, producing `get_attachments` (not `attachments_get_attachments` or `getattachments`) for both Python and Rust.

## 5. CLI Semantics

`build` command (`src/cli/index.ts`) gains one option; `runBuild` gains one field.

- `--sdk <langs>` — comma list; valid values `{python, rust}` only. TS is the implicit default and is **not** selectable here (it is already always-on). An unknown value fails fast: `invalid --sdk language "go"; valid: python, rust`.
- `--skip-sdk` and `--sdk` are **mutually exclusive.** `--skip-sdk` keeps its existing frozen behavior unchanged — it skips the TS SDK, which is the only SDK that exists without `--sdk`, so in practice it means "no SDKs at all." This rule is a CLI guard against the contradictory combination (`--skip-sdk` requesting no SDKs while `--sdk` requests Fern SDKs), **not** a change to the `--skip-sdk` semantics locked in §2.2. The combination fails fast: `--skip-sdk cannot be combined with --sdk`.
- `RunBuildOptions` gains `fernLangs?: FernLang[]`. `build.ts` parses/validates the comma list (dedup, lowercase, membership check) and passes it through.

Edge values:
- `--sdk ""` → no langs (no-op; TS only).
- `--sdk python,python` → de-duplicated to `["python"]`.

## 6. Docker Detection + `warm`

**Detection (fail-fast).** Before any Fern work, probe `docker info` (the daemon must be *running*, not merely installed — `docker --version` is insufficient). If it fails and `--sdk` was requested:

```
skillship: --sdk python,rust requires Docker, but the Docker daemon
isn't reachable. Start Docker Desktop (or run `skillship sdk warm`
once online to cache the generator images), then retry.
TypeScript SDK was generated normally.
```

The TS SDK has already been written by this point, so the message states that explicitly.

**`skillship sdk warm` subcommand.** A one-time prefetch that `docker pull`s the digest-pinned generator images so later builds work fully offline. Prints per-image progress and a final "offline-ready" confirmation. (New `sdk` command group with a `warm` subcommand, sibling to `init`/`build`.)

## 7. Fern Project Scaffolding

All scaffolding lives in a temp dir, torn down after generation.

- `fern/fern.config.json` → `{ "organization": "skillship", "version": "<pinned fern CLI version>" }`
- `fern/generators.yml` → only the requested langs, each digest-pinned:

  ```yaml
  groups:
    sdks:
      generators:
        - name: fernapi/fern-python-sdk
          version: "@sha256:..."   # or exact tag + lockfile if digests unsupported
          output: { location: local-file-system, path: ../out/python }
        - name: fernapi/fern-rust-sdk
          version: "@sha256:..."
          output: { location: local-file-system, path: ../out/rust }
  ```

- `fern/openapi/openapi.json` → the rewritten temp OAS (§4).
- **Python package-root fix.** Configure the Python generator's package name (e.g. `<product>_sdk`) so all modules nest under one importable root. This avoids the spike's failure where a top-level `types/` directory shadowed the stdlib `types` module during compile checks. Belt-and-suspenders: the regen lane's compile check runs from a neutral CWD.
- **Fern CLI invocation** is pinned (exact `fern-api` version via `npx`/devDependency); the CLI orchestrates the digest-pinned Docker images.

## 8. Output Packaging + Atomicity

Fern writes to a temp `out/{python,rust}`. Each language tree is then **atomically moved** into its sibling dir (`sdk-python/`, `sdk-rust/`) — the same discipline `renderSdkPackage` uses for `sdk/`. Properties:

- If Fern fails for one language, no partial sibling dir is left behind; the other language and the TS `sdk/` are unaffected, and the failing generator's logs are surfaced.
- The already-written top-level artifacts and the TS `sdk/` persist regardless of Fern outcome (consistent with today's "the SDK subtree is independently atomic" behavior).

## 9. Testing Strategy

Per the locked contract (§2.4):

- **Committed golden trees.** `sdk-python/` and `sdk-rust/` for the existing two fixtures (`tests/fixtures/golden/sdk-minimal`, `tests/fixtures/golden/sdk-graphql-minimal` — Resend-sized small SaaS APIs, matching the production bar), added as sibling golden trees (e.g. `tests/fixtures/golden/sdk-python-minimal`, `sdk-rust-minimal`, and GraphQL variants).
- **Normal CI (pure Node, no Docker).** Byte-compares the committed trees against fixtures. Runs everywhere; fast. This gate protects against accidental engine/rewriter changes.
- **Docker regen lane (opt-in / nightly).** Runs `fern generate --local` against the digest-pinned images and diffs against the committed goldens. Because images are digest-pinned, a clean diff is the steady state; a non-empty diff means a deliberate (or accidental) image/rewriter change.
- **Compile gates (parity with TS `tsc --noEmit`).** `cargo check` (Rust) and `python -m compileall` (Python) run **in the Docker regen lane** — where toolchains exist — **not** in pure-Node CI and **not** at user build time. This preserves "opt-in path adds only Docker."
- **Regen script.** `scripts/gen-sdk-goldens.mts` extended with `--langs python,rust` (Docker required), mirroring the existing `gen-goldens.mts` / `gen-sdk-goldens.mts` pattern.
- **Unit tests (pure Node, no Docker).** The OAS-rewriter (operationId/tags shape, `camelToSnake`, collision handling); `--sdk`/`--skip-sdk` arg validation; the Docker-absent fail-fast message.

## 10. Scope Boundaries (MVP)

**In v1:**
- Resource-tree naming (namespaces + idiomatic method names) via the rewrite lever.
- Auth — Fern reads `securitySchemes` from the OAS natively, so bearer auth works out of the box (spike-confirmed).
- Standard CRUD operations; nested idiomatic packages for Python + Rust.

**Deferred** (matches the TS-side deferral to Plan 2b): propagating the `CodegenOverlay`'s **pagination / retries / streaming / webhooks** semantics into the Fern output. Fern's generated runtime uses its own defaults for these in v1; wiring our overlay → Fern's `x-fern-*` extensions is a later plan. Trade-off acknowledged: the Python/Rust SDKs in v1 do not reflect our overlay's pagination/retry/streaming/webhook configuration.

## 11. Edge Cases

| Case | Behavior |
|------|----------|
| `--sdk ""` | No langs; no-op (TS only). |
| `--sdk python,python` | De-duplicated. |
| Unknown lang (`--sdk go`) | Fail fast with valid list. |
| `--skip-sdk` + `--sdk` together | Fail fast (mutually exclusive). |
| Docker daemon not running | Fail fast with actionable message; TS SDK already emitted. |
| One generator fails, other succeeds | Failing sibling dir not created; other lang + TS unaffected; logs surfaced. |
| Fern `generators.yml` rejects digest pinning | Fall back to exact tag + recorded digest lockfile (verify mechanism in plan). |

## 12. Open Verification Items (resolve during plan-writing, not implementation)

1. **Digest pinning support** — confirm Fern's `generators.yml` accepts `@sha256:...`; if not, define the tag + lockfile fallback precisely.
2. **Snake_case tokenization** — confirm Fern strips the leading `namespace_` token and re-cases the remainder to `get_attachments` for both Python and Rust (§4).
3. **Python package root** — confirm the package-name config eliminates top-level stdlib-shadowing modules in generated output.
4. **GraphQL operation naming** — GraphQL operations are projected with a fragment path `/graphql#fieldName`; `deriveMethodName` returns the fragment field as the method (`resource-tree.ts:208-220`), a different branch from the REST verb/segment logic. Confirm the snake_case `operationId` rewrite (§4) and Fern's tokenizer produce clean idiomatic method names for these too. The plan's one-shot tokenization spike (§12.2) **must run the `sdk-graphql-minimal` fixture**, not only the REST `sdk-minimal` fixture, since the two exercise different `deriveMethodName` branches.

## 13. Freeze Note

- `substrate/frozen` — **unaffected** (no extractor changes).
- `r-sdk-wedge/frozen` — retags forward when this lands (exports `resolveAssignments`/`Assignment` from `resource-tree.ts` and adds `renderFernSdks`).
