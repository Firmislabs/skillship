# Multi-Language SDK (Opt-In Python + Rust via Fern) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Python and Rust SDKs as an explicitly opt-in, Docker-gated `skillship build` capability via Fern `--local`, beside the unchanged zero-dependency TypeScript path.

**Architecture:** A new `src/renderers/sdk-fern.ts` is called after the existing `renderSdkPackage`, guarded by `langs.length > 0`. It reuses the existing `extractOperations` + the (newly exported) `resolveAssignments` naming engine to rewrite a temp OAS copy (`operationId = snake(ns)_snake(method)`, `tags = [ns]`), scaffolds a temp Fern project with digest-pinned generators, runs `fern generate --local`, and atomically moves each language's output to sibling `sdk-python/` / `sdk-rust/` dirs. The TS path is not modified.

**Tech Stack:** TypeScript (Node ≥20, ESM), `commander`, `yaml`, `vitest`, `tsx`, Fern CLI (`fern-api`, invoked on demand via `npx`), Docker (Fern generator images).

**Spec:** `docs/superpowers/specs/2026-05-28-multi-language-sdk-design.md`

---

## File Structure

### New files

| File | Responsibility |
|------|----------------|
| `src/renderers/fern-images.ts` | Single source of truth for pinned Fern toolchain: CLI version + per-language generator image (name, tag, digest, image ref). Consumed by the scaffolder, `sdk warm`, and the regen lane. The only place a bump can change Python/Rust output. |
| `src/renderers/fern-oas-rewrite.ts` | Pure. `camelToSnake` + `buildFernOas(oasJson, ops, overlay)` → a new OAS JSON string with `operationId`/`tags` rewritten from `resolveAssignments`. Never mutates the input. |
| `src/renderers/fern-project.ts` | Pure. `buildFernProject(langs)` → in-memory `{ relPath → content }` for `fern/fern.config.json` + `fern/generators.yml` (digest-pinned, per-language output paths, Python package-root config). |
| `src/renderers/fern-docker.ts` | Side-effectful. `assertDockerAvailable(exec?)` (probes `docker info`, throws `DockerUnavailableError`) + `runFernGenerate(projectDir)` (`npx fern-api@<pinned> generate --local`). Injectable exec seam for tests. |
| `src/renderers/sdk-fern.ts` | Orchestrator. `renderFernSdks(input)` ties the steps together, loops per language for independent atomicity, returns emitted dirs. |
| `src/cli/sdk-langs.ts` | Pure. `parseFernLangs(raw)` + `assertSdkFlagsCompatible(skipSdk, langs)` for the `--sdk` flag. |
| `src/cli/sdk.ts` | `runSdkWarm()` for the `skillship sdk warm` subcommand (pre-pull pinned images + prefetch Fern CLI). |
| `tests/renderers/fern-oas-rewrite.test.ts` | Unit tests (pure Node) for `camelToSnake` + `buildFernOas`. |
| `tests/renderers/fern-project.test.ts` | Unit tests (pure Node) for `buildFernProject`. |
| `tests/renderers/fern-docker.test.ts` | Unit tests (pure Node) for `assertDockerAvailable` via a stubbed exec + the error message. |
| `tests/renderers/sdk-fern.test.ts` | Unit test (pure Node): empty-langs → early return, no Docker call. |
| `tests/cli/sdk-langs.test.ts` | Unit tests (pure Node) for `parseFernLangs` + `assertSdkFlagsCompatible`. |
| `tests/renderers/sdk-fern-golden-helpers.ts` | Docker-required helpers that regenerate the Python/Rust golden trees from the existing fixtures. |
| `tests/renderers/sdk-fern-golden.test.ts` | Pure-Node golden lock: committed-tree manifest check + structural/no-leakage assertions (no Docker). |
| `.github/workflows/sdk-docker.yml` | Separate Docker lane (nightly + `workflow_dispatch` + fern-path PR changes): regenerate, byte-diff vs committed goldens, `cargo check`, `python -m compileall`. |
| `tests/fixtures/golden/sdk-python-minimal/` etc. | Committed golden trees (4: python/rust × rest/graphql) + sibling `.manifest.json` files. |

### Modified files

| File | Change |
|------|--------|
| `src/sdk-plugins/resource-tree.ts` | Export `resolveAssignments` + `Assignment` (currently internal). No behavior change. |
| `src/cli/build.ts` | Add `fernLangs?: FernLang[]` to `RunBuildOptions`; after the TS SDK block, call `renderFernSdks` when `fernLangs.length > 0` and append emitted files to artifacts. |
| `src/cli/index.ts` | Add `--sdk <langs>` to `build` (parse + mutual-exclusion with `--skip-sdk`); register the `sdk warm` command. |
| `tests/renderers/sdk-golden-helpers.ts` | Extract an exported `buildGoldenOas(args)` so the Fern golden helper reuses the same ingest→OAS path. |
| `scripts/gen-sdk-goldens.mts` | Accept `--langs python,rust` to (re)generate the Fern golden trees + write their manifests. |
| `KNOWN_GAPS.md` | Note deferred overlay pagination/retries/streaming/webhooks for Fern output; record the 3 spike outcomes. |

---

## Pre-Flight (run once before Phase 0)

- [ ] **P1: Confirm a green baseline**

Run: `npm ci && npm run typecheck && npm test && npm run build`
Expected: all pass (this is the substrate the plan builds on). If anything fails, STOP and investigate before starting — do not begin on a red baseline (autonomous Rule 3).

- [ ] **P2: Record the starting frozen tag**

Run: `git tag -l 'r-sdk-wedge/frozen' && git rev-parse r-sdk-wedge/frozen`
Expected: prints the tag and its commit. Note it — Task 13 retags `r-sdk-wedge/frozen` forward. `substrate/frozen` is NOT touched (no extractor changes).

- [ ] **P3: Confirm Docker is available for the spikes**

Run: `docker info >/dev/null 2>&1; echo "DOCKER_EXIT=$?"`
Expected: `DOCKER_EXIT=0`. The three spikes and the golden-generation tasks require Docker. If unavailable, start Docker Desktop first.

---

## Phase 0 — Verification Spikes (sequence FIRST; outcomes set implementation constants)

These are investigation tasks, **not** TDD. Each ends by recording its outcome in the file noted, which downstream tasks consume. Use throwaway scripts under `/tmp/sdkspike-plan/`; commit nothing from this phase except the recorded constants (in their respective tasks).

### Spike 0.1: Fern digest-pin acceptance

**Question:** Does `generators.yml` accept an immutable digest for `version`, or only a published tag?

> **RESOLVED (executed 2026-05-28, fern-api@5.40.0):**
> - **cliVersion = 5.40.0** (cached + latest published; succeeds). `fern/fern.config.json` = `{"organization":"skillship","version":"5.40.0"}` works.
> - **Resolved digests:** rust `sha256:04f5adc1cd0faafaa2583cfaaa5af1055f17454907ac387cee6d705659f0c1d6`; python `sha256:0daab174eeca54710a75cc35775922d0a51015224159e35cb8d3c69611433084`.
> - **Digest pinning is NOT cleanly supported.** Tested 5 forms: `version: "<digest>"` → "Failed to parse version" (version field requires semver); `name: "<repo@digest>"` (no version) → schema rejects; `name: "<repo@digest>" + version` → "Unrecognized generator … specify ir-version" (Fern infers IR version by *name*-registry lookup, which a digest defeats — it falls into the brittle custom-generator path needing a hand-pinned `ir-version`); `image: "<string>"` → schema expects an object, not a string. Only tag-based `version: 0.36.8` succeeds via the blessed path.
> - **DECISION (plan's pre-specified fallback): tag-pin + recorded-digest.** `pinnedVersion()` returns the tag; `FERN_PINS.generators.*.digest` holds the sha256 for verification/`docker pull` only. Drift defense = Fern's immutable per-version publishing + the Docker regen lane's golden byte-diff (Task 12).
> - **BLOCKER FOUND → folded into Task 4:** `generators.yml` MUST include an `api:` block (`api: { specs: [{ openapi: "openapi/openapi.json" }] }`); without it Fern aborts with "Detected empty API definition." Task 4's `buildFernProject` + its test updated accordingly.

- [ ] **Step 1: Resolve the digests**

```bash
docker pull fernapi/fern-rust-sdk:0.36.8
docker pull fernapi/fern-python-sdk:5.14.4
docker inspect --format '{{index .RepoDigests 0}}' fernapi/fern-rust-sdk:0.36.8
docker inspect --format '{{index .RepoDigests 0}}' fernapi/fern-python-sdk:5.14.4
```
Record both `…@sha256:…` digests.

- [ ] **Step 2: Try a digest-pinned generate**

Scaffold a minimal Fern project under `/tmp/sdkspike-plan/digest/` (`fern/fern.config.json` = `{"organization":"skillship","version":"*"}`, `fern/generators.yml` with `version: "fernapi/fern-rust-sdk@sha256:…"` form, and any tiny OAS), then:
```bash
cd /tmp/sdkspike-plan/digest && npx --yes fern-api@<latest> generate --local --group sdks; echo "FERN_EXIT=$?"
```
Try the digest in the `version:` field; if rejected, try `name: fernapi/fern-rust-sdk@sha256:…` with `version` omitted.

- [ ] **Step 3: Record the outcome**

- If a digest form works → in Task 3, set `FERN_PINS.generators.*.digest` to the sha256 and have `pinnedVersion()` return it.
- If only tags work → keep `digest` recorded (for `docker pull` in `warm` + the regen lane's verification) but have `pinnedVersion()` return the tag. Note the fallback decision in `KNOWN_GAPS.md` (Task 13).
- Also record the exact `npx fern-api@<version>` that succeeded → set `FERN_PINS.cliVersion` in Task 3.

### Spike 0.2: snake_case tokenization (REST **and** GraphQL fixtures)

**Question:** Does `operationId = snake(ns)_snake(method)` + `tags = [ns]` make Fern emit clean idiomatic method names (`get_attachments`, not `getattachments`) for both REST and GraphQL-derived operations?

> **RESOLVED (executed 2026-05-28, fern-api@5.40.0, python 5.14.4 + rust 0.36.8):** Validated on the real `tests/fixtures/graphql/minimal.graphql` (decisive multi-word case `createProject`) and `tests/fixtures/openapi3/minimal.yaml`, both rewritten through the real `resolveAssignments` engine.
> - **SNAKE input** (`mutation_create_project`, `tags:[mutation]`) → Python `def create_project(...)`, Rust `pub async fn create_project(...)`. ✅
> - **CAMEL control** (`mutation_createProject`) → Python `def createproject(...)`, Rust `pub async fn createproject(...)`. ❌ This is exactly the `getattachments` bug class — snake_case is required.
> - **No `op_<hex>` leakage** in either snake output (grep clean). Namespace grouping works: GraphQL → `mutation/` + `query/` packages; REST → `projects/`. Method names clean: `list`, `create`, `create_project`, `projects`.
> - The spike's `camelToSnake` (`/([a-z0-9])([A-Z])/`→`$1_$2`, `/([A-Z]+)([A-Z][a-z])/`→`$1_$2`, `[-\s]+`→`_`, lowercase) handles all Task 2 cases (`getAttachments`→`get_attachments`, `apiKeys`→`api_keys`, `list`→`list`, `createProject`→`create_project`). Implement Task 2's `camelToSnake` as written.
> - **Note for Spike 0.3:** the Python output put `types/`, `core/`, `errors/` at the package *root* (no package nesting) — Spike 0.3 addresses this.

- [ ] **Step 1: Produce both fixtures' OAS**

```bash
mkdir -p /tmp/sdkspike-plan/snake
npx tsx -e '
import { writeFileSync } from "node:fs";
import { buildGoldenOasStandalone } from "/Users/riteshkewlani/github/skillship/tests/renderers/sdk-golden-helpers.ts";
' 2>/dev/null || true
```
Simpler: temporarily log the `oasJson` from `renderSdkGoldenRest`/`renderSdkGoldenGraphql` (they already build it), or call `renderSyntheticOpenApi` on `tests/fixtures/openapi3/minimal.yaml` and `tests/fixtures/graphql/minimal.graphql` exactly as `sdk-golden-helpers.ts` does. Save to `/tmp/sdkspike-plan/snake/rest.json` and `gql.json`.

- [ ] **Step 2: Apply a throwaway snake_case rewrite**

Adapt the existing spike script `/tmp/sdkspike/rewrite-oas.mjs` (validated for "qualified" mode) to set `operationId = snake(ns)_snake(method)` and `tags=[ns]`. Run it on both `rest.json` and `gql.json`.

- [ ] **Step 3: Generate + inspect**

Run Fern (python + rust) on each rewritten OAS. Then:
```bash
grep -rEi 'getattachments|op_[0-9a-f]{6,}' /tmp/sdkspike-plan/snake/out || echo "NO_LEAKAGE_OR_BADCASE"
grep -rn 'def get_attachments\|fn get_attachments' /tmp/sdkspike-plan/snake/out | head
```
Expected: no `getattachments`/`op_<hex>` leakage; idiomatic snake methods present. For the GraphQL fixture, confirm the fragment-derived method names (see `resource-tree.ts:208-220`) also emit cleanly.

- [ ] **Step 4: Record the outcome**

- If snake_case is correct → Task 2 implements `camelToSnake` + `buildFernOas` as specified.
- If Fern mangles a specific case → adjust `camelToSnake` (Task 2) and note the case in `KNOWN_GAPS.md`. If two camelCase names in one namespace collapse to the same snake (rare), Fern errors loudly on a duplicate `operationId` — acceptable; record as a known follow-up, do not pre-engineer a fix.

### Spike 0.3: Python package-root config

**Question:** Which `generators.yml` generator `config` key sets the Python package name so all modules nest under one import root (no top-level `types/` shadowing stdlib), and does `python -m compileall` pass from a neutral CWD?

> **RESOLVED (executed 2026-05-28, fern-api@5.40.0, fern-python-sdk 5.14.4):**
> - **Config key = `package_name`** (confirmed against the generator's `SDKCustomConfig` schema in the image: `/src/fern_python/generators/sdk/custom_config.py`). Setting `package_name: skillship_sdk` rewrites the **import root shown in docstring example code** (`from skillship_sdk import SkillshipApi` instead of the org-derived default `from skillship import …`) — verified by diffing config vs no-config output (6 files differ, all docstring/example `TYPE_CHECKING` import lines; runtime imports are all relative `from ..types.… import …`).
> - **`local-file-system` mode emits a FLAT package** (`types/`, `core/`, `errors/`, `projects/` at the output root). Neither `package_name` nor `output_directory: project-root` produces a `src/<package>/` wrapper in this mode — `output_directory: project-root` was silently ignored (no `src/`, no rename). So **no config key nests the modules** under local-file-system; the flat layout is inherent. The plan's documented fallback applies.
> - **The top-level `types/` shadows stdlib ONLY in the pathological case** where the package-root directory is placed *directly* on `sys.path`. Under normal consumption — the package imported by name from its parent (exactly how our sibling `sdk-python/` dir is consumed) — `from types import GeneratorType` in `core/jsonable_encoder.py` is an absolute import that resolves to **stdlib** `types`, not the sibling package. Verified: `importlib.import_module("python.core.jsonable_encoder")` with the parent on `sys.path` succeeds (stdlib resolved); the same import with the package-root dir itself on `sys.path` raises the circular-import shadow error. Real installs/imports use the safe path.
> - **`python -m compileall` from a neutral CWD (`/tmp`) → exit 0** in all variants (the Task 12 regen-lane guard).
> - **Byte-deterministic:** two independent `fern generate` runs of the python SDK produced byte-identical trees (0 diff lines, including `.fern/metadata.json`). De-risks Task 11.
> - **DECISION:** Task 4 sets `config: { package_name: "skillship_sdk" }` for python (clean, consistent docstring import root; fully deterministic), and **no** config for rust. Accept the flat layout as Fern's native local-file-system output. The Docker regen lane (Task 12) runs `python -m compileall` from a neutral CWD as the safety guard. Record the flat-layout + pathological-shadow note in `KNOWN_GAPS.md` (Task 13).

- [ ] **Step 1: Try the package-name config**

In a `/tmp/sdkspike-plan/pyroot/` Fern project, set the python generator's `config:` (consult the `fernapi/fern-python-sdk` generator README for the exact key — candidates: `package_name`, `module_name`). Generate.

- [ ] **Step 2: Inspect layout + compile**

```bash
find /tmp/sdkspike-plan/pyroot/out/python -maxdepth 2 -type d
cd /tmp && python3 -m compileall -q /tmp/sdkspike-plan/pyroot/out/python; echo "COMPILE_EXIT=$?"
```
Expected: a single package root (e.g. `skillship_sdk/`), no top-level `types/`; `COMPILE_EXIT=0`.

- [ ] **Step 3: Record the outcome**

Set the exact key+value in Task 4's `generatorConfig("python")`. If no key prevents a top-level collision, document that the regen lane runs `compileall` from a neutral CWD (Task 12) and note in `KNOWN_GAPS.md`.

---

## Phase 1 — Shared Engine + Pure Modules

### Task 1: Export the naming-assignment engine

**Files:**
- Modify: `src/sdk-plugins/resource-tree.ts:76` (the `Assignment` interface) and `:102` (the `resolveAssignments` function)

- [ ] **Step 1: Write the failing test**

Create `tests/sdk-plugins/resolve-assignments-export.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import {
  resolveAssignments,
  type Assignment,
  type OperationInfo,
} from "../../src/sdk-plugins/resource-tree.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

describe("resolveAssignments export", () => {
  test("returns one assignment per op with namespace + methodName", () => {
    const ops: OperationInfo[] = [
      { operationId: "op_a", tags: ["emails"], method: "GET", path: "/emails" },
      { operationId: "op_b", tags: ["emails"], method: "POST", path: "/emails" },
    ];
    const out: Assignment[] = resolveAssignments(ops, CodegenOverlaySchema.parse({}));
    expect(out).toEqual([
      { op: ops[0], namespace: "emails", methodName: "list" },
      { op: ops[1], namespace: "emails", methodName: "create" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/sdk-plugins/resolve-assignments-export.test.ts`
Expected: FAIL — `resolveAssignments` / `Assignment` are not exported.

- [ ] **Step 3: Add the exports**

In `src/sdk-plugins/resource-tree.ts`, change `interface Assignment {` → `export interface Assignment {` (line ~76) and `function resolveAssignments(` → `export function resolveAssignments(` (line ~102). No other change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/sdk-plugins/resolve-assignments-export.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (existing internal callers still compile).

- [ ] **Step 5: Commit**

```bash
git add src/sdk-plugins/resource-tree.ts tests/sdk-plugins/resolve-assignments-export.test.ts
git commit -m "feat: export resolveAssignments + Assignment from resource-tree"
```

### Task 2: OAS rewrite (`fern-oas-rewrite.ts`)

**Files:**
- Create: `src/renderers/fern-oas-rewrite.ts`
- Test: `tests/renderers/fern-oas-rewrite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { camelToSnake, buildFernOas } from "../../src/renderers/fern-oas-rewrite.js";
import { extractOperations } from "../../src/renderers/sdk-utils.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

describe("camelToSnake", () => {
  test.each([
    ["getAttachments", "get_attachments"],
    ["apiKeys", "api_keys"],
    ["list", "list"],
    ["getURL", "get_url"],
    ["_2fa", "_2fa"],
  ])("%s -> %s", (input, expected) => {
    expect(camelToSnake(input)).toBe(expected);
  });
});

describe("buildFernOas", () => {
  const oas = JSON.stringify({
    openapi: "3.1.0",
    paths: {
      "/emails": {
        get: { operationId: "op_aaa", tags: ["emails"] },
        post: { operationId: "op_bbb", tags: ["emails"] },
      },
    },
  });

  test("rewrites operationId=snake(ns)_snake(method) and tags=[ns]; input unchanged", () => {
    const ops = extractOperations(oas);
    const out = buildFernOas(oas, ops, CodegenOverlaySchema.parse({}));
    const doc = JSON.parse(out);
    expect(doc.paths["/emails"].get.operationId).toBe("emails_list");
    expect(doc.paths["/emails"].get.tags).toEqual(["emails"]);
    expect(doc.paths["/emails"].post.operationId).toBe("emails_create");
    // input string not mutated
    expect(JSON.parse(oas).paths["/emails"].get.operationId).toBe("op_aaa");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderers/fern-oas-rewrite.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`src/renderers/fern-oas-rewrite.ts`:
```ts
// src/renderers/fern-oas-rewrite.ts
// Produces a Fern-friendly OAS variant: every operation's operationId becomes
// snake(namespace)_snake(methodName) and tags becomes [namespace], derived from
// the SAME resolveAssignments pass that drives the TS SDK (single source of
// truth). The input OAS string is never mutated; a new JSON string is returned.
import type { CodegenOverlay } from "../overlays/codegen.js";
import {
  resolveAssignments,
  type OperationInfo,
} from "../sdk-plugins/resource-tree.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "head", "options", "trace",
]);

interface MutOp {
  operationId?: string;
  tags?: string[];
  [k: string]: unknown;
}
type MutPathItem = Record<string, MutOp>;
interface MutDoc {
  paths?: Record<string, MutPathItem>;
  [k: string]: unknown;
}

/** Converts a camelCase/PascalCase identifier to snake_case. */
export function camelToSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Returns a new OAS JSON string with operationId + tags rewritten for Fern.
 * Operations are matched back to the doc by their ORIGINAL operationId (unique),
 * so this is robust to whatever path shape the synthetic OAS uses (incl. GraphQL).
 */
export function buildFernOas(
  oasJson: string,
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): string {
  const doc = JSON.parse(oasJson) as MutDoc;
  const byOpId = new Map<string, { operationId: string; namespace: string }>();
  for (const a of resolveAssignments(ops, overlay)) {
    byOpId.set(a.op.operationId, {
      operationId: `${camelToSnake(a.namespace)}_${camelToSnake(a.methodName)}`,
      namespace: a.namespace,
    });
  }
  const paths = doc.paths ?? {};
  for (const pathKey of Object.keys(paths)) {
    const item = paths[pathKey]!;
    for (const method of Object.keys(item)) {
      if (!HTTP_METHODS.has(method.toLowerCase())) continue;
      const op = item[method];
      if (!op || typeof op !== "object" || typeof op.operationId !== "string") continue;
      const hit = byOpId.get(op.operationId);
      if (!hit) continue;
      op.operationId = hit.operationId;
      op.tags = [hit.namespace];
    }
  }
  return JSON.stringify(doc, null, 2);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/renderers/fern-oas-rewrite.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/fern-oas-rewrite.ts tests/renderers/fern-oas-rewrite.test.ts
git commit -m "feat: add fern OAS rewrite (snake_case operationId + namespace tags)"
```

### Task 3: Pinned image registry (`fern-images.ts`)

**Files:**
- Create: `src/renderers/fern-images.ts`
- Test: (covered indirectly by Task 4; add a tiny invariant test)

> **Spike inputs (RESOLVED — already filled in below):** `cliVersion = "5.40.0"`; per-generator `digest` recorded for verification only; `pinnedVersion()` returns the `tag` (Spike 0.1). Values below are final — implement as written.

- [ ] **Step 1: Write the failing test**

Create `tests/renderers/fern-images.test.ts`:
```ts
import { describe, expect, test } from "vitest";
import { FERN_PINS, pinnedVersion } from "../../src/renderers/fern-images.js";

describe("FERN_PINS", () => {
  test("has python + rust pins with image refs", () => {
    expect(FERN_PINS.generators.python.image).toMatch(/fern-python-sdk/);
    expect(FERN_PINS.generators.rust.image).toMatch(/fern-rust-sdk/);
    expect(FERN_PINS.cliVersion).not.toBe("");
  });
  test("pinnedVersion returns the tag (digest is verification-only; Spike 0.1)", () => {
    // Fern's generators.yml `version:` requires a semver tag — a digest there fails
    // ("Failed to parse version"). digest is recorded for docker-pull + golden verification.
    expect(pinnedVersion({ name: "x", tag: "1.0.0", digest: "sha256:abc", image: "x:1.0.0" }))
      .toBe("1.0.0");
    expect(pinnedVersion({ name: "x", tag: "1.0.0", digest: null, image: "x:1.0.0" }))
      .toBe("1.0.0");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderers/fern-images.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/renderers/fern-images.ts
// Single source of truth for pinned Fern toolchain versions. Bumping a value
// here is the ONLY sanctioned way Python/Rust SDK output is allowed to change.
export type FernLang = "python" | "rust";

export interface FernGeneratorPin {
  readonly name: string;   // generators.yml name
  readonly tag: string;    // exact published tag — used in generators.yml `version:`
  readonly digest: string | null; // recorded sha256 for docker-pull + golden verification ONLY; NOT usable in generators.yml `version:` (Spike 0.1)
  readonly image: string;  // fully-qualified ref for `docker pull`
}

export interface FernToolchainPins {
  readonly cliVersion: string; // npx fern-api@<version>
  readonly generators: Readonly<Record<FernLang, FernGeneratorPin>>;
}

export const FERN_PINS: FernToolchainPins = {
  cliVersion: "5.40.0",
  generators: {
    python: {
      name: "fernapi/fern-python-sdk",
      tag: "5.14.4",
      digest: "sha256:0daab174eeca54710a75cc35775922d0a51015224159e35cb8d3c69611433084",
      image: "fernapi/fern-python-sdk:5.14.4",
    },
    rust: {
      name: "fernapi/fern-rust-sdk",
      tag: "0.36.8",
      digest: "sha256:04f5adc1cd0faafaa2583cfaaa5af1055f17454907ac387cee6d705659f0c1d6",
      image: "fernapi/fern-rust-sdk:0.36.8",
    },
  },
};

/**
 * Version string for generators.yml `version:` — ALWAYS the tag. Fern rejects a
 * digest here ("Failed to parse version"); the recorded `digest` is for docker-pull
 * + golden verification only (Spike 0.1).
 */
export function pinnedVersion(pin: FernGeneratorPin): string {
  return pin.tag;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/renderers/fern-images.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/fern-images.ts tests/renderers/fern-images.test.ts
git commit -m "feat: add pinned Fern toolchain registry (digest/tag + CLI version)"
```

### Task 4: Fern project scaffolder (`fern-project.ts`)

**Files:**
- Create: `src/renderers/fern-project.ts`
- Test: `tests/renderers/fern-project.test.ts`

> **Spike input:** the Python `config` key+value from Spike 0.3.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFernProject } from "../../src/renderers/fern-project.js";

describe("buildFernProject", () => {
  test("emits fern.config.json + generators.yml for requested langs only", () => {
    const { files } = buildFernProject(["python"]);
    expect(files["fern/fern.config.json"]).toContain('"organization": "skillship"');
    const gen = parseYaml(files["fern/generators.yml"]);
    // api.specs is required — Fern aborts with "empty API definition" without it (Spike 0.1).
    expect(gen.api.specs).toEqual([{ openapi: "openapi/openapi.json" }]);
    const names = gen.groups.sdks.generators.map((g: { name: string }) => g.name);
    expect(names).toEqual(["fernapi/fern-python-sdk"]);
    expect(gen.groups.sdks.generators[0].output.path).toBe("../out/python");
    // Spike 0.3: package_name sets the docstring import root; deterministic.
    expect(gen.groups.sdks.generators[0].config).toEqual({ package_name: "skillship_sdk" });
  });

  test("rust generator carries no python package config", () => {
    const { files } = buildFernProject(["rust"]);
    const gen = parseYaml(files["fern/generators.yml"]);
    expect(gen.groups.sdks.generators[0].config).toBeUndefined();
  });

  test("throws on empty langs", () => {
    expect(() => buildFernProject([])).toThrow(/non-empty/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderers/fern-project.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/renderers/fern-project.ts
// Pure emission of a temp Fern project for the requested languages. Output dirs
// are RELATIVE to the fern/ project root (Fern resolves local-file-system paths
// from there). The caller writes the rewritten OAS to fern/openapi/openapi.json,
// which the required `api:` block in generators.yml points at (Spike 0.1: without
// an `api:` section Fern fails with "Detected empty API definition").
import { stringify as stringifyYaml } from "yaml";
import { FERN_PINS, pinnedVersion, type FernLang } from "./fern-images.js";

export interface FernProjectFiles {
  readonly files: Readonly<Record<string, string>>;
}

interface GeneratorEntry {
  name: string;
  version: string;
  output: { location: string; path: string };
  config?: Record<string, unknown>;
}

export function buildFernProject(langs: readonly FernLang[]): FernProjectFiles {
  if (langs.length === 0) {
    throw new Error("buildFernProject: langs must be non-empty");
  }
  const generators: GeneratorEntry[] = langs.map((lang) => {
    const pin = FERN_PINS.generators[lang];
    const entry: GeneratorEntry = {
      name: pin.name,
      version: pinnedVersion(pin),
      output: { location: "local-file-system", path: `../out/${lang}` },
    };
    const cfg = generatorConfig(lang);
    if (cfg !== undefined) entry.config = cfg;
    return entry;
  });
  const fernConfig = { organization: "skillship", version: FERN_PINS.cliVersion };
  // `api.specs` is REQUIRED — Fern aborts with "Detected empty API definition"
  // otherwise. Path is relative to fern/ (caller writes fern/openapi/openapi.json).
  const generatorsDoc = {
    api: { specs: [{ openapi: "openapi/openapi.json" }] },
    groups: { sdks: { generators } },
  };
  return {
    files: {
      "fern/fern.config.json": JSON.stringify(fernConfig, null, 2) + "\n",
      "fern/generators.yml": stringifyYaml(generatorsDoc),
    },
  };
}

/**
 * Per-language generator config. Python sets `package_name` so docstring example
 * code reads `from skillship_sdk import …` (Spike 0.3 — it does NOT change physical
 * layout; local-file-system mode is always flat). Rust takes no config.
 */
function generatorConfig(lang: FernLang): Record<string, unknown> | undefined {
  if (lang === "python") {
    return { package_name: "skillship_sdk" };
  }
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/renderers/fern-project.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/fern-project.ts tests/renderers/fern-project.test.ts
git commit -m "feat: add Fern project scaffolder (generators.yml + fern.config.json)"
```

---

## Phase 2 — Docker Integration

### Task 5: Docker detection + Fern invocation (`fern-docker.ts`)

**Files:**
- Create: `src/renderers/fern-docker.ts`
- Test: `tests/renderers/fern-docker.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import {
  assertDockerAvailable,
  DockerUnavailableError,
} from "../../src/renderers/fern-docker.js";

describe("assertDockerAvailable", () => {
  test("resolves when exec succeeds", async () => {
    await expect(
      assertDockerAvailable(async () => ({ stdout: "ok", stderr: "" })),
    ).resolves.toBeUndefined();
  });

  test("throws DockerUnavailableError with actionable message when exec fails", async () => {
    const failing = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), {
        code: "ENOENT",
        stderr: "Cannot connect to the Docker daemon",
      });
    };
    await expect(assertDockerAvailable(failing)).rejects.toBeInstanceOf(DockerUnavailableError);
    await expect(assertDockerAvailable(failing)).rejects.toThrow(/skillship sdk warm/);
    await expect(assertDockerAvailable(failing)).rejects.toThrow(/TypeScript SDK was generated normally/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderers/fern-docker.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/renderers/fern-docker.ts
// The only side-effectful seam of the Fern path: Docker probe + Fern invocation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FERN_PINS } from "./fern-images.js";

const execFileP = promisify(execFile);

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class DockerUnavailableError extends Error {
  constructor(detail: string) {
    super(
      "skillship: --sdk requires Docker, but the Docker daemon isn't reachable " +
        `(${detail}). Start Docker Desktop (or run \`skillship sdk warm\` once ` +
        "online to cache the generator images), then retry. " +
        "TypeScript SDK was generated normally.",
    );
    this.name = "DockerUnavailableError";
  }
}

/** Probes `docker info`; throws DockerUnavailableError if the daemon is unreachable. */
export async function assertDockerAvailable(exec: ExecFn = execFileP): Promise<void> {
  try {
    await exec("docker", ["info"], { timeout: 15000 });
  } catch (err: unknown) {
    const e = err as { code?: string | number; stderr?: string };
    const detail =
      typeof e.stderr === "string" && e.stderr.trim().length > 0
        ? e.stderr.trim().split("\n")[0]!
        : `docker info failed (${String(e.code ?? "unknown")})`;
    throw new DockerUnavailableError(detail);
  }
}

/** Runs `npx --yes fern-api@<pinned> generate --local --group sdks` in projectDir. */
export async function runFernGenerate(
  projectDir: string,
  exec: ExecFn = execFileP,
): Promise<void> {
  await exec(
    "npx",
    ["--yes", `fern-api@${FERN_PINS.cliVersion}`, "generate", "--local", "--group", "sdks"],
    { cwd: projectDir, timeout: 600000 },
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/renderers/fern-docker.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderers/fern-docker.ts tests/renderers/fern-docker.test.ts
git commit -m "feat: add Docker detection + Fern CLI invocation"
```

### Task 6: Orchestrator (`sdk-fern.ts`)

**Files:**
- Create: `src/renderers/sdk-fern.ts`
- Test: `tests/renderers/sdk-fern.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { renderFernSdks } from "../../src/renderers/sdk-fern.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

describe("renderFernSdks", () => {
  test("empty langs short-circuits with no emission and no Docker call", async () => {
    const result = await renderFernSdks({
      oasJson: JSON.stringify({ openapi: "3.1.0", paths: {} }),
      productName: "x",
      outDir: "/tmp/should-not-be-written",
      overlay: CodegenOverlaySchema.parse({}),
      langs: [],
    });
    expect(result.emitted).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderers/sdk-fern.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/renderers/sdk-fern.ts
// Orchestrates the opt-in Python/Rust path. Called AFTER renderSdkPackage; the
// TS path is untouched. Loops per language so one generator failing does not
// block another (failed languages are aggregated; successful sibling dirs and
// the TS sdk/ persist).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodegenOverlay } from "../overlays/codegen.js";
import { extractOperations } from "./sdk-utils.js";
import { buildFernOas } from "./fern-oas-rewrite.js";
import { buildFernProject } from "./fern-project.js";
import { assertDockerAvailable, runFernGenerate } from "./fern-docker.js";
import { atomicMove, statSyncSafe } from "./sdk-fs.js";
import type { FernLang } from "./fern-images.js";

export type { FernLang } from "./fern-images.js";

export interface RenderFernSdksInput {
  readonly oasJson: string;
  readonly productName: string;
  /** The {product} skill dir; the renderer writes sdk-<lang>/ siblings under it. */
  readonly outDir: string;
  readonly overlay: CodegenOverlay;
  readonly langs: readonly FernLang[];
}

export interface FernSdkResult {
  readonly emitted: readonly { lang: FernLang; path: string }[];
}

export async function renderFernSdks(
  input: RenderFernSdksInput,
): Promise<FernSdkResult> {
  if (input.langs.length === 0) return { emitted: [] };
  await assertDockerAvailable();
  const ops = extractOperations(input.oasJson);
  const fernOas = buildFernOas(input.oasJson, ops, input.overlay);

  const emitted: { lang: FernLang; path: string }[] = [];
  const failures: string[] = [];
  for (const lang of input.langs) {
    try {
      const path = await renderOneLang(lang, fernOas, input.outDir);
      emitted.push({ lang, path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${lang}: ${msg}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `renderFernSdks: ${failures.length} generator(s) failed (${failures.join("; ")}). ` +
        "Successful languages and the TypeScript SDK were written.",
    );
  }
  return { emitted };
}

async function renderOneLang(
  lang: FernLang,
  fernOas: string,
  outDir: string,
): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), `sk-fern-${lang}-`));
  try {
    const { files } = buildFernProject([lang]);
    for (const [rel, content] of Object.entries(files)) {
      const target = join(projectDir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const oasTarget = join(projectDir, "fern", "openapi", "openapi.json");
    mkdirSync(dirname(oasTarget), { recursive: true });
    writeFileSync(oasTarget, fernOas, "utf8");

    await runFernGenerate(projectDir);

    const generated = join(projectDir, "out", lang);
    if (!statSyncSafe(generated)) {
      throw new Error(`Fern produced no output at out/${lang}`);
    }
    const dest = join(outDir, `sdk-${lang}`);
    atomicMove(generated, dest);
    return dest;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/renderers/sdk-fern.test.ts && npm run typecheck`
Expected: PASS (empty-langs path needs no Docker).

- [ ] **Step 5: Commit**

```bash
git add src/renderers/sdk-fern.ts tests/renderers/sdk-fern.test.ts
git commit -m "feat: add renderFernSdks orchestrator (per-language atomic emission)"
```

---

## Phase 3 — CLI

### Task 7: `--sdk` flag parsing (`sdk-langs.ts`)

**Files:**
- Create: `src/cli/sdk-langs.ts`
- Test: `tests/cli/sdk-langs.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "vitest";
import { parseFernLangs, assertSdkFlagsCompatible } from "../../src/cli/sdk-langs.js";

describe("parseFernLangs", () => {
  test("undefined / empty -> []", () => {
    expect(parseFernLangs(undefined)).toEqual([]);
    expect(parseFernLangs("")).toEqual([]);
    expect(parseFernLangs("  ")).toEqual([]);
  });
  test("parses + lowercases + dedups", () => {
    expect(parseFernLangs("python,rust")).toEqual(["python", "rust"]);
    expect(parseFernLangs("Python,python")).toEqual(["python"]);
  });
  test("throws on unknown lang", () => {
    expect(() => parseFernLangs("go")).toThrow(/invalid --sdk language "go"; valid: python, rust/);
  });
});

describe("assertSdkFlagsCompatible", () => {
  test("throws when --skip-sdk combined with --sdk", () => {
    expect(() => assertSdkFlagsCompatible(true, ["python"])).toThrow(/cannot be combined/);
  });
  test("allows each alone", () => {
    expect(() => assertSdkFlagsCompatible(true, [])).not.toThrow();
    expect(() => assertSdkFlagsCompatible(false, ["python"])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/sdk-langs.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// src/cli/sdk-langs.ts
import type { FernLang } from "../renderers/fern-images.js";

const VALID: readonly FernLang[] = ["python", "rust"];

export function parseFernLangs(raw: string | undefined): FernLang[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: FernLang[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!VALID.includes(part as FernLang)) {
      throw new Error(`invalid --sdk language "${part}"; valid: ${VALID.join(", ")}`);
    }
    if (!out.includes(part as FernLang)) out.push(part as FernLang);
  }
  return out;
}

export function assertSdkFlagsCompatible(
  skipSdk: boolean,
  langs: readonly FernLang[],
): void {
  if (skipSdk && langs.length > 0) {
    throw new Error("--skip-sdk cannot be combined with --sdk");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/sdk-langs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/sdk-langs.ts tests/cli/sdk-langs.test.ts
git commit -m "feat: add --sdk language parsing + skip-sdk mutual-exclusion guard"
```

### Task 8: Wire `renderFernSdks` into `runBuild`

**Files:**
- Modify: `src/cli/build.ts:29-37` (imports + `RunBuildOptions`) and `:92-105` (the SDK tail of `runBuild`)
- Test: `tests/cli/build-sdk-fern-noop.test.ts`

- [ ] **Step 1: Write the failing test (no-Docker no-op path)**

No shared `runBuildOnFixture` harness exists — `tests/helpers.ts` only exports `makeTmpCtx`. Mirror the `stageProject()` setup from `tests/cli/build-sdk.test.ts:20-48` (read it first; it stages a `.skillship/` fixture from `tests/fixtures/openapi3/minimal.yaml` with domain `min.example` → product slug `min-example`). The no-op guard:
```ts
// Verifies the build wiring treats absent/empty fernLangs as a pure no-op:
// no Docker, no sdk-python/ dir. (Full Docker generation is covered by the
// golden tasks + the Docker CI lane.)
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";

const FIXTURE_SPEC = readFileSync(
  join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"),
  "utf8",
);

// Copy of stageProject() from tests/cli/build-sdk.test.ts (keep in sync).
function stageProject(): { inDir: string; outDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sk-build-fern-noop-"));
  const inDir = join(root, "in");
  const outDir = join(root, "out");
  mkdirSync(join(inDir, ".skillship/sources"), { recursive: true });
  const sha = createHash("sha256").update(FIXTURE_SPEC).digest("hex");
  writeFileSync(join(inDir, ".skillship/sources", `${sha}.yaml`), FIXTURE_SPEC, "utf8");
  const cfg = `product:
  domain: min.example
  github_org: null
sources:
  - url: https://min.example/openapi.yaml
    surface: rest
    sha256: ${sha}
    content_type: application/openapi+yaml
    fetched_at: 2026-05-20T00:00:00.000Z
coverage: bronze
`;
  writeFileSync(join(inDir, ".skillship/config.yaml"), cfg, "utf8");
  return { inDir, outDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("build wiring: fernLangs no-op", () => {
  test("omitting fernLangs produces no sdk-python/ or sdk-rust/", async () => {
    const { inDir, outDir, cleanup } = stageProject();
    try {
      await runBuild({ in: inDir, out: outDir });
      const skillDir = join(outDir, "min-example");
      expect(existsSync(join(skillDir, "sdk-python"))).toBe(false);
      expect(existsSync(join(skillDir, "sdk-rust"))).toBe(false);
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes trivially)**

Run: `npx vitest run tests/cli/build-sdk-fern-noop.test.ts`
Expected: PASS is acceptable here only after Step 3 wiring exists and defaults to no-op; if you assert behavior not yet wired, it FAILs first. (This is an integration guard, not a unit RED.) Prefer to write Step 3 wiring, then confirm this guard passes.

- [ ] **Step 3: Implement the wiring**

In `src/cli/build.ts`:

Add imports near line 29 (note: `renderSdkPackage` is **already** imported at line 29 — do NOT re-add it; add only these three):
```ts
import { renderFernSdks } from "../renderers/sdk-fern.js";
import { listEmittedFiles } from "../renderers/sdk-fs.js";
import type { FernLang } from "../renderers/fern-images.js";
```

Extend `RunBuildOptions`:
```ts
export interface RunBuildOptions {
  readonly in: string;
  readonly out: string;
  readonly productId?: string;
  readonly description?: string;
  readonly skipSdk?: boolean;
  readonly fernLangs?: readonly FernLang[];
}
```

Replace the SDK tail. The current code (build.ts:92-105) is an `if (opts.skipSdk !== true) { … return { …, [...artifacts, ...sdkArtifacts], … }; }` block with an **embedded `return` at line 103**, followed by a **trailing bare `return` at line 105**. The replacement below removes BOTH of those `return` statements and collapses them into a single linear flow with one trailing `return`. Keep the atomicity comment at lines 89-91 above it; replace exactly lines 92-105:
```ts
    const artifactsAll: BuildArtifact[] = [...artifacts];
    if (opts.skipSdk !== true) {
      const sdkResult = await renderSdkPackage({
        oasJson,
        productName,
        outDir: join(skillDir, "sdk"),
        overlay: codegenOverlay,
      });
      for (const relPath of sdkResult.files) {
        const filePath = join(sdkResult.outDir, relPath);
        artifactsAll.push({ path: filePath, bytes: statSync(filePath).size });
      }
    }
    const fernLangs = opts.fernLangs ?? [];
    if (fernLangs.length > 0) {
      const fernResult = await renderFernSdks({
        oasJson,
        productName,
        outDir: skillDir,
        overlay: codegenOverlay,
        langs: fernLangs,
      });
      for (const e of fernResult.emitted) {
        for (const relPath of listEmittedFiles(e.path)) {
          const filePath = join(e.path, relPath);
          artifactsAll.push({ path: filePath, bytes: statSync(filePath).size });
        }
      }
    }
    return { productId, artifacts: artifactsAll, ingest };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/build-sdk-fern-noop.test.ts tests/cli/build-sdk.test.ts && npm run typecheck`
Expected: PASS — existing build-sdk behavior unchanged; no-op guard holds.

- [ ] **Step 5: Commit**

```bash
git add src/cli/build.ts tests/cli/build-sdk-fern-noop.test.ts
git commit -m "feat: wire renderFernSdks into runBuild (opt-in, guarded)"
```

### Task 9: `--sdk` option + `sdk warm` subcommand

**Files:**
- Modify: `src/cli/index.ts:59-81` (build command) and add the `sdk` command group
- Create: `src/cli/sdk.ts`

- [ ] **Step 1: Implement `runSdkWarm`**

`src/cli/sdk.ts`:
```ts
// src/cli/sdk.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FERN_PINS, type FernLang } from "../renderers/fern-images.js";

const execFileP = promisify(execFile);

export async function runSdkWarm(): Promise<void> {
  for (const lang of Object.keys(FERN_PINS.generators) as FernLang[]) {
    const pin = FERN_PINS.generators[lang];
    process.stdout.write(`skillship sdk warm: pulling ${pin.image}...\n`);
    await execFileP("docker", ["pull", pin.image], { timeout: 600000 });
  }
  process.stdout.write(`skillship sdk warm: prefetching fern-api@${FERN_PINS.cliVersion}...\n`);
  await execFileP("npx", ["--yes", `fern-api@${FERN_PINS.cliVersion}`, "--version"], {
    timeout: 120000,
  });
  process.stdout.write("skillship sdk warm: offline-ready (images + CLI cached)\n");
}
```

- [ ] **Step 2: Wire the build flag + sdk command in `index.ts`**

Add imports:
```ts
import { parseFernLangs, assertSdkFlagsCompatible } from "./sdk-langs.js";
import { runSdkWarm } from "./sdk.js";
```

In the `build` command definition add the option after `--skip-sdk`:
```ts
    .option("--sdk <langs>", "also emit Python/Rust SDKs via Fern (requires Docker), e.g. python,rust")
```

In the `build` action, update the options type to include `sdk?: string`, then before calling `runBuild`:
```ts
      const fernLangs = parseFernLangs(opts.sdk);
      assertSdkFlagsCompatible(opts.skipSdk === true, fernLangs);
      const result = await runBuild({
        in: inDir,
        out: outDir,
        ...(opts.productId !== undefined ? { productId: opts.productId } : {}),
        ...(opts.skipSdk === true ? { skipSdk: true } : {}),
        ...(fernLangs.length > 0 ? { fernLangs } : {}),
      });
```

Register the `sdk` command group (after the `build` command, before `return program`):
```ts
  const sdk = program
    .command("sdk")
    .description("Multi-language SDK helpers (Python/Rust via Fern)");
  sdk
    .command("warm")
    .description("Pre-pull pinned generator images + Fern CLI for offline use")
    .action(async () => {
      await runSdkWarm();
    });
```

- [ ] **Step 3: Verify build + help**

Run:
```bash
npm run build
node dist/cli/index.js build --help | grep -- "--sdk"
node dist/cli/index.js sdk warm --help | grep -qi "Pre-pull" && echo OK
node dist/cli/index.js build --skip-sdk --sdk python 2>&1 | grep -q "cannot be combined" && echo EXCLUSIVE_OK
```
Expected: `--sdk` listed in build help; `OK`; `EXCLUSIVE_OK`.

- [ ] **Step 4: Run the full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts src/cli/sdk.ts
git commit -m "feat: add --sdk build flag + skillship sdk warm subcommand"
```

---

## Phase 4 — Goldens + Testing

### Task 10: Fern golden helpers + regen script + generate committed goldens

**Files:**
- Modify: `tests/renderers/sdk-golden-helpers.ts` (extract `buildGoldenOas`)
- Create: `tests/renderers/sdk-fern-golden-helpers.ts`
- Modify: `scripts/gen-sdk-goldens.mts` (accept `--langs`)
- Create (generated, committed): `tests/fixtures/golden/sdk-python-minimal/`, `sdk-rust-minimal/`, `sdk-python-graphql-minimal/`, `sdk-rust-graphql-minimal/` + sibling `<tree>.manifest.json`

> **Requires Docker.** This task generates the committed artifacts the pure-Node lock (Task 11) and the Docker lane (Task 12) both depend on.

- [ ] **Step 1: Extract `buildGoldenOas` from `sdk-golden-helpers.ts`**

Refactor `renderSdkGoldenFromFixture` so the ingest→OAS portion is an exported function. Note `buildGoldenOas` does NOT need `outDir` (only `renderSdkPackage` does), so give it its own arg type:
```ts
export interface GoldenOasArgs {
  readonly fixturePath: string;
  readonly contentType: string;
  readonly productId: string;
  readonly productName: string;
}

export interface GoldenOas {
  readonly oasJson: string;
  readonly productName: string;
  readonly overlay: CodegenOverlay; // CodegenOverlaySchema.parse({})
}

export async function buildGoldenOas(args: GoldenOasArgs): Promise<GoldenOas> {
  // (the mkdtemp + openGraph + ingestConfig + renderSyntheticOpenApi body
  //  currently inside renderSdkGoldenFromFixture, MINUS the renderSdkPackage
  //  call, returning { oasJson, productName: args.productName,
  //  overlay: CodegenOverlaySchema.parse({}) }. Keep the tmp-graph cleanup.)
}
```
Keep `renderSdkGoldenRest/Graphql` working by having `renderSdkGoldenFromFixture(args: FixtureArgs)` call `buildGoldenOas({ fixturePath, contentType, productId, productName })`, then `renderSdkPackage({ oasJson, productName, outDir: args.outDir, overlay })`. Run `npx vitest run tests/renderers/sdk-golden.test.ts` to confirm the TS goldens are still byte-identical (no behavior change).

- [ ] **Step 2: Add the Fern golden helpers**

`tests/renderers/sdk-fern-golden-helpers.ts`:
```ts
// Docker-required. Regenerates the Python/Rust golden trees from the same
// fixtures the TS goldens use, via renderFernSdks.
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildGoldenOas } from "./sdk-golden-helpers.js";
import { renderFernSdks } from "../../src/renderers/sdk-fern.js";
import type { FernLang } from "../../src/renderers/fern-images.js";

export type GoldenFixture = "rest" | "graphql";

/** The committed-tree name for a (lang, fixture) pair. Single source of truth
 *  shared by the regen script + (implicitly) the pure-Node lock's TREES list. */
export function fernTreeName(lang: FernLang, fixture: GoldenFixture): string {
  return fixture === "rest" ? `sdk-${lang}-minimal` : `sdk-${lang}-graphql-minimal`;
}

export async function renderFernGolden(
  fixture: GoldenFixture,
  outParentDir: string,
  langs: readonly FernLang[],
): Promise<void> {
  const args =
    fixture === "rest"
      ? { fixturePath: "tests/fixtures/openapi3/minimal.yaml", contentType: "application/openapi+yaml", productId: "p-min", productName: "min.example" }
      : { fixturePath: "tests/fixtures/graphql/minimal.graphql", contentType: "application/graphql", productId: "p-gql", productName: "gql.example" };
  const { oasJson, productName, overlay } = await buildGoldenOas(args);
  await renderFernSdks({
    oasJson,
    productName,
    outDir: outParentDir, // renderFernSdks writes sdk-<lang>/ siblings here
    overlay, // reuse the overlay buildGoldenOas already resolved (single source of truth)
    langs,
  });
  // renderFernSdks always emits the generic `sdk-<lang>/`; rename each to the
  // fixture-qualified committed-tree name so rest + graphql don't collide.
  for (const lang of langs) {
    const generic = join(outParentDir, `sdk-${lang}`);
    const target = join(outParentDir, fernTreeName(lang, fixture));
    rmSync(target, { recursive: true, force: true });
    renameSync(generic, target);
  }
}
```

- [ ] **Step 3: Extend `gen-sdk-goldens.mts` with `--langs`**

Add arg parsing: when `--langs python,rust` is passed, additionally regenerate the Fern trees into `tests/fixtures/golden/`. `renderFernGolden` (Step 2) already leaves the fixture-qualified committed-tree names (`sdk-<lang>-minimal` / `sdk-<lang>-graphql-minimal`) — the script just writes each tree's sibling `<tree>.manifest.json` (sorted relpath → sha256). Reuse `parseFernLangs` + the shared `fernTreeName`. The existing script imports only `rmSync` from `node:fs` and `join` from `node:path` — add `readFileSync` + `writeFileSync` (node:fs) and `createHash` (node:crypto). Example addition:
```ts
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseFernLangs } from "../src/cli/sdk-langs.js";
import {
  renderFernGolden,
  fernTreeName,
  type GoldenFixture,
} from "../tests/renderers/sdk-fern-golden-helpers.js";
import { listEmittedFiles } from "../src/renderers/sdk-fs.js";
// ... after the TS goldens:
const langs = parseFernLangs(process.argv.find((a) => a.startsWith("--langs="))?.slice("--langs=".length)
  ?? (process.argv.includes("--langs") ? process.argv[process.argv.indexOf("--langs") + 1] : undefined));
const parent = join(repoRoot, "tests/fixtures/golden");
for (const fixture of ["rest", "graphql"] as const satisfies readonly GoldenFixture[]) {
  if (langs.length === 0) break;
  // renderFernGolden renames sdk-<lang>/ -> fernTreeName(lang, fixture) internally,
  // rm-ing any prior target first, so no pre-clean is needed here.
  await renderFernGolden(fixture, parent, langs);
  for (const lang of langs) {
    const dir = join(parent, fernTreeName(lang, fixture));
    const manifest: Record<string, string> = {};
    for (const rel of listEmittedFiles(dir)) {
      manifest[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
    }
    writeFileSync(`${dir}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    process.stdout.write(`wrote ${dir} (+ manifest)\n`);
  }
}
```

- [ ] **Step 4: Generate + sanity-check**

Run:
```bash
npx tsx scripts/gen-sdk-goldens.mts --langs python,rust
ls tests/fixtures/golden | grep -E 'sdk-(python|rust)(-graphql)?-minimal'
grep -rEi 'op_[0-9a-f]{6,}|getattachments' tests/fixtures/golden/sdk-python-minimal && echo "LEAK!" || echo "CLEAN"
```
Expected: four trees present + four manifests; `CLEAN`.

- [ ] **Step 5: Commit the generated goldens**

```bash
git add tests/renderers/sdk-golden-helpers.ts tests/renderers/sdk-fern-golden-helpers.ts scripts/gen-sdk-goldens.mts tests/fixtures/golden/sdk-python-minimal tests/fixtures/golden/sdk-rust-minimal tests/fixtures/golden/sdk-python-graphql-minimal tests/fixtures/golden/sdk-rust-graphql-minimal tests/fixtures/golden/*.manifest.json
git commit -m "feat: generate committed Python/Rust SDK golden trees + manifests"
```

### Task 11: Pure-Node golden lock (manifest + structural)

**Files:**
- Create: `tests/renderers/sdk-fern-golden.test.ts`

- [ ] **Step 1: Write the test**

```ts
// Pure Node, NO Docker. Two layers:
//  (1) manifest integrity: recompute sha256 of every committed file, compare to
//      the committed <tree>.manifest.json (catches hand-edits / partial drift).
//  (2) structural + no-leakage: required marker file present; no op_<hex> or
//      camelCase-collapse leakage anywhere in the tree.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(process.cwd(), "tests/fixtures/golden");
const TREES: { dir: string; marker: string }[] = [
  { dir: "sdk-python-minimal", marker: "pyproject.toml" },
  { dir: "sdk-rust-minimal", marker: "Cargo.toml" },
  { dir: "sdk-python-graphql-minimal", marker: "pyproject.toml" },
  { dir: "sdk-rust-graphql-minimal", marker: "Cargo.toml" },
];

function listRel(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listRel(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out.sort();
}

describe("Fern SDK golden lock (pure Node)", () => {
  for (const { dir, marker } of TREES) {
    const treeDir = join(ROOT, dir);
    test(`${dir}: manifest integrity`, () => {
      const manifest = JSON.parse(readFileSync(`${treeDir}.manifest.json`, "utf8")) as Record<string, string>;
      const files = listRel(treeDir);
      expect(files).toEqual(Object.keys(manifest).sort());
      for (const rel of files) {
        const got = createHash("sha256").update(readFileSync(join(treeDir, rel))).digest("hex");
        expect(got, `manifest mismatch in ${dir}/${rel}`).toBe(manifest[rel]);
      }
    });
    test(`${dir}: structural + no leakage`, () => {
      expect(existsSync(join(treeDir, marker)), `${marker} missing`).toBe(true);
      for (const rel of listRel(treeDir)) {
        const body = readFileSync(join(treeDir, rel), "utf8");
        expect(body, `op_<hex> leak in ${rel}`).not.toMatch(/op_[0-9a-f]{6,}/);
      }
    });
  }
});
```

- [ ] **Step 2: Run + verify pass**

Run: `npx vitest run tests/renderers/sdk-fern-golden.test.ts`
Expected: PASS (no Docker).

- [ ] **Step 3: Negative check (manifest catches edits)**

Temporarily append a space to one committed generated file, run the test, confirm the manifest test FAILS, then `git checkout` the file.

- [ ] **Step 4: Commit**

```bash
git add tests/renderers/sdk-fern-golden.test.ts
git commit -m "test: pure-Node Fern golden lock (manifest + no-leakage)"
```

### Task 12: Docker regen lane (`.github/workflows/sdk-docker.yml`)

**Files:**
- Create: `.github/workflows/sdk-docker.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: SDK Docker Lane

on:
  workflow_dispatch:
  schedule:
    - cron: "0 7 * * *" # nightly
  pull_request:
    branches: [main]
    paths:
      - "src/renderers/fern-*.ts"
      - "src/renderers/sdk-fern.ts"
      - "src/sdk-plugins/resource-tree.ts"
      - "scripts/gen-sdk-goldens.mts"
      - "tests/renderers/sdk-fern-golden*"
      - ".github/workflows/sdk-docker.yml"

jobs:
  regen-and-verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - uses: dtolnay/rust-toolchain@stable
      - run: npm ci
      - run: npm run build

      - name: Warm Fern images
        run: node dist/cli/index.js sdk warm

      - name: Regenerate Fern goldens
        run: npx tsx scripts/gen-sdk-goldens.mts --langs python,rust

      - name: Byte-diff regenerated trees vs committed goldens
        run: |
          git diff --exit-code -- \
            tests/fixtures/golden/sdk-python-minimal \
            tests/fixtures/golden/sdk-rust-minimal \
            tests/fixtures/golden/sdk-python-graphql-minimal \
            tests/fixtures/golden/sdk-rust-graphql-minimal \
            'tests/fixtures/golden/*.manifest.json'

      - name: Rust compile gate
        run: |
          for d in tests/fixtures/golden/sdk-rust-minimal tests/fixtures/golden/sdk-rust-graphql-minimal; do
            cargo check --manifest-path "$d/Cargo.toml"
          done

      - name: Python compile gate (neutral CWD)
        run: |
          cd /tmp
          for d in sdk-python-minimal sdk-python-graphql-minimal; do
            python3 -m compileall -q "$GITHUB_WORKSPACE/tests/fixtures/golden/$d"
          done
```

- [ ] **Step 2: Validate locally what you can**

Run (locally, with Docker): `node dist/cli/index.js sdk warm && npx tsx scripts/gen-sdk-goldens.mts --langs python,rust && git diff --exit-code -- tests/fixtures/golden`
Expected: clean (no diff — digest-pinned determinism). Run the two compile gates locally too if toolchains present.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/sdk-docker.yml
git commit -m "ci: add Docker regen lane (regen + byte-diff + compile gates)"
```

---

## Phase 5 — Wrap-Up

### Task 13: Docs + retag frozen

**Files:**
- Modify: `KNOWN_GAPS.md`

- [ ] **Step 1: Update KNOWN_GAPS.md**

Add a "Multi-language SDK (Fern)" section recording: (a) deferred overlay pagination/retries/streaming/webhooks for Python/Rust output (parity with the TS Plan 2b deferral); (b) the Spike 0.1 digest-vs-tag decision; (c) the Spike 0.2 snake_case result + any edge case; (d) the Spike 0.3 Python package-root key (or the compileall-from-neutral-CWD fallback); (e) the camelCase→snake collision note (loud Fern failure, follow-up only if triggered).

- [ ] **Step 2: Final full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: all PASS. Capture exit codes (autonomous Rule 1): `echo "FINAL_EXIT=$?"`.

- [ ] **Step 3: Commit docs**

```bash
git add KNOWN_GAPS.md
git commit -m "docs: record Fern multi-language SDK gaps + spike outcomes"
```

- [ ] **Step 4: Retag `r-sdk-wedge/frozen` forward**

```bash
git tag -f r-sdk-wedge/frozen HEAD
git tag -l 'r-sdk-wedge/frozen' && git rev-parse r-sdk-wedge/frozen
```
> `substrate/frozen` is intentionally NOT moved (no extractor changes). Do not push tags unless the user explicitly asks.

---

## Determinism & Risk Notes

- **Determinism contract:** output changes only when `FERN_PINS` is bumped. The Docker lane's byte-diff (Task 12) is the enforcement; the pure-Node manifest test (Task 11) guards committed artifacts against hand-edits.
- **First-run network:** `npx fern-api@…` and the generator images need network on first use, then run offline from cache (`skillship sdk warm`). This mirrors the digest-pin story; `assertDockerAvailable` fails fast with the `warm` hint.
- **`oasJson` is a string** everywhere (matches `renderSdkPackage` + `extractOperations`); `buildFernOas` parses internally and never mutates the input.
- **Naming invariant:** Fern names derive from `extractOperations` → `resolveAssignments` — the exact pass that drives the TS SDK. Matching is by original `operationId` (unique), robust to path shape (incl. GraphQL `/graphql#…`).
- **YAGNI:** no emitter registry, no overlay→Fern extension wiring, no TS-via-Fern. Two languages, one orchestrator, per-language atomic emission.
