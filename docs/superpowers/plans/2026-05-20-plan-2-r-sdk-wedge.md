# Plan 2 — R-SDK Wedge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a publishable, idiomatic TypeScript SDK npm package emitted from the synthetic OpenAPI document, using three custom Hey API plugins on top of `@hey-api/openapi-ts`. The emit passes `tsc --noEmit` strict, demonstrates nested resources (`client.projects.create(...)`), surfaces a typed error hierarchy, and ships a fetch-based runtime with declarative auth injection.

**Architecture:** A new top-level renderer `src/renderers/sdk.ts` orchestrates Hey API codegen, writes package templates, runs Prettier, gates on `tsc --noEmit`, and atomic-moves the temp emit dir to its final destination. Three custom Hey API plugins (`src/sdk-plugins/{resource-tree,errors,runtime}.ts`) shape the output. Build wiring (`src/cli/build.ts`) adds an opt-out `--skip-sdk` flag.

**Tech Stack:** TypeScript (NodeNext ESM, strict), `@hey-api/openapi-ts` (MIT, exact pin), `prettier` (MIT), `typescript` (Apache-2.0, already in repo), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-20-plan-1.5-plus-r-sdk-design.md` §5.

**Prerequisite:** Plan 1.5 must be merged. `substrate/frozen` must point at the Plan 1.5 final commit. The first task verifies this gate.

---

## File Structure

### New files
| File | Responsibility |
|---|---|
| `src/renderers/sdk.ts` | Orchestrator: `renderSdkPackage(input): Promise<SdkRenderResult>`. Sequences Hey API codegen → templates → Prettier → tsc gate → atomic-move. Splits into small helpers (writeOasToTemp, runHeyApiCodegen, writePackageTemplates, formatWithPrettier, runTypecheckGate, atomicMove). |
| `src/sdk-plugins/resource-tree.ts` | Hey API plugin that reshapes the client into nested namespaces driven by `CodegenOverlay.resources`. Falls back to `tags[0]` when no rule matches. |
| `src/sdk-plugins/errors.ts` | Hey API plugin that emits the 7-class typed error hierarchy (`APIError` base + 6 subclasses) and wraps transport response handling. |
| `src/sdk-plugins/runtime.ts` | Hey API plugin that emits the `Client` constructor, fetch wrapper, and auth-injection logic driven by `securitySchemes`. |
| `src/renderers/sdk-templates/package.json.tpl` | npm package manifest template with `{{PRODUCT_NAME}}`, `{{LICENSE}}` placeholders |
| `src/renderers/sdk-templates/tsconfig.json.tpl` | Strict TypeScript config template for the emitted package |
| `src/renderers/sdk-templates/README.md.tpl` | README template with `{{PRODUCT_NAME}}` placeholder |
| `src/renderers/sdk-templates/LICENSE.tpl` | MIT license template with `{{YEAR}}`, `{{HOLDER}}` placeholders |
| `src/renderers/sdk-templates/npmignore.tpl` | .npmignore template (static) |
| `tests/sdk-plugins/resource-tree.test.ts` | Unit tests for resource-tree plugin (overlay-driven nesting + tags fallback) |
| `tests/sdk-plugins/errors.test.ts` | Unit tests for errors plugin (7 classes, status mapping, fallback to base) |
| `tests/sdk-plugins/runtime.test.ts` | Unit tests for runtime plugin (constructor signature, auth injection per scheme) |
| `tests/renderers/sdk.test.ts` | Determinism test (two consecutive renders produce byte-identical trees) |
| `tests/renderers/sdk-golden-helpers.ts` | Shared render helpers (no vitest imports) used by both golden lock test and gen-sdk-goldens script |
| `tests/renderers/sdk-golden.test.ts` | Byte-identity lock test + tsc-gate test for both golden trees |
| `tests/cli/build-sdk.test.ts` | End-to-end test exercising `runBuild` with and without `--skip-sdk` |
| `tests/fixtures/golden/sdk-minimal/` | REST SDK golden tree (committed) |
| `tests/fixtures/golden/sdk-minimal/README.md` | Documents the golden-diff review process (per R2-4 mitigation) |
| `tests/fixtures/golden/sdk-graphql-minimal/` | GraphQL SDK golden tree (committed) |
| `scripts/gen-sdk-goldens.mts` | One-off generator that calls `renderSdkGoldenRest()` and `renderSdkGoldenGraphql()`, writes results to the two golden trees |

### Modified files
| File | Change |
|---|---|
| `src/cli/build.ts` | Add `--skip-sdk` to `RunBuildOptions`; after existing `writeAll`, if `!opts.skipSdk`, invoke `renderSdkPackage` and append its files to `BuildResult.artifacts`. |
| `src/cli/index.ts` | Add `--skip-sdk` boolean flag to the `build` command; pass through to `runBuild`. |
| `package.json` | Add deps `@hey-api/openapi-ts@<exact-pin>` and `prettier@<exact-pin>` |
| `package-lock.json` | Updated by npm install |

### Tag operation (at plan completion)
- Tag `r-sdk-wedge/frozen` at the Plan 2 final commit.

---

## Pre-flight (run before Task 1)

- [ ] **Step 0.1: Verify Plan 1.5 prerequisite is met**

```bash
cd /Users/riteshkewlani/github/skillship
git rev-parse substrate/frozen
git log substrate/frozen --format='%H %s' -1
git status
```

Expected: `substrate/frozen` is at the Plan 1.5 final commit (look for the "Plan 1.5 final preflight" or KNOWN_GAPS-update commit subject). Working tree clean.

- [ ] **Step 0.2: Verify baseline tests + typecheck pass**

```bash
npm test 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: both exit 0. If either fails, STOP and resolve before starting Plan 2.

- [ ] **Step 0.3: Read this plan's spec section once**

Read `docs/superpowers/specs/2026-05-20-plan-1.5-plus-r-sdk-design.md` §5 (Plan 2 section). Note the four locked decisions in §2 — they are inputs, not subject to re-litigation:
1. Plugin scope is the wedge (resource-tree + errors + runtime only — no pagination, retries, streaming, webhooks)
2. Sequencing — this plan starts only after Plan 1.5 ships
3. Packaging — top-level at `{outDir}/{product}/sdk/` with `--skip-sdk` flag
4. Conformance — `tsc --noEmit` + plugin unit tests + golden lock (no msw)

---

## Task 1: Install Hey API + Prettier dependencies

**Spec ref:** §5.8 of the spec.

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1.1: Verify package licenses are permissive**

```bash
npm view @hey-api/openapi-ts license version 2>&1; echo "VIEW_EXIT_CODE=$?"
npm view prettier license version 2>&1; echo "VIEW_EXIT_CODE=$?"
```

Expected: both report `MIT`. Note the latest stable version of each (call them `<HEYAPI_VERSION>` and `<PRETTIER_VERSION>` in the steps below). If `@hey-api/openapi-ts` is anything other than MIT, STOP — the project's all-permissive constraint is broken.

- [ ] **Step 1.2: Install with exact pins**

```bash
npm install --save-exact @hey-api/openapi-ts@<HEYAPI_VERSION> prettier@<PRETTIER_VERSION> 2>&1 | tail -10; echo "NPM_EXIT_CODE=$?"
```

Expected: `NPM_EXIT_CODE=0`. Exact pin (no caret) is mandatory per spec §5.9 R2-1 mitigation.

- [ ] **Step 1.3: Verify the install matches the pin**

```bash
node -e 'const p = require("./package.json"); console.log(p.dependencies["@hey-api/openapi-ts"], p.dependencies["prettier"]);'
```

Expected: exact version strings with no `^` or `~` prefix.

- [ ] **Step 1.4: Verify typecheck still passes after install**

```bash
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: `TSC_EXIT_CODE=0`. The new packages should not affect existing source.

- [ ] **Step 1.5: Read Hey API plugin API contract before writing plugins**

Read the plugin authoring docs that ship with the installed Hey API package:

```bash
find node_modules/@hey-api/openapi-ts -name "*.d.ts" -path "*plugin*" | head -10
cat node_modules/@hey-api/openapi-ts/README.md 2>/dev/null | head -80
```

Capture the plugin factory signature (typically `defineConfig({ plugins: [...] })` + custom plugin shape) into a comment in `src/sdk-plugins/resource-tree.ts` when that file is created in Task 4. Per spec §5.8: include the exact pinned version in a comment alongside the import in `src/renderers/sdk.ts` once the renderer is written.

- [ ] **Step 1.6: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @hey-api/openapi-ts and prettier (Plan 2 prep)

Both pinned exactly (no caret) per spec §5.9 R2-1 mitigation
(Hey API plugin API drift risk).

Licenses verified MIT for both. Repo stays fully permissive.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Scaffold `src/renderers/sdk.ts` skeleton + types

**Spec ref:** §5.3 (Components — `src/renderers/sdk.ts`).

**Files:**
- Create: `src/renderers/sdk.ts`
- Create: `tests/renderers/sdk.test.ts` (skeleton)

- [ ] **Step 2.1: Write the failing skeleton test**

Create `tests/renderers/sdk.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import type { RenderSdkInput, SdkRenderResult } from "../../src/renderers/sdk.js";

describe("renderSdkPackage — type surface (skeleton)", () => {
  test("RenderSdkInput type has required fields", () => {
    // Compile-time check via a satisfying value
    const sample: RenderSdkInput = {
      oasJson: "{}",
      productName: "min.example",
      outDir: "/tmp/sdk-out",
      overlay: {
        resources: {},
        streaming: [],
      },
    };
    expect(sample.productName).toBe("min.example");
  });

  test("SdkRenderResult type has expected fields", () => {
    const sample: SdkRenderResult = {
      outDir: "/tmp/sdk-out",
      files: [],
      typecheckExitCode: 0,
    };
    expect(sample.typecheckExitCode).toBe(0);
  });
});
```

- [ ] **Step 2.2: Run test to verify it fails**

```bash
npx vitest run tests/renderers/sdk.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1`. Module `src/renderers/sdk.ts` does not exist yet.

- [ ] **Step 2.3: Create the skeleton**

Create `src/renderers/sdk.ts`:

```typescript
// src/renderers/sdk.ts
// pinned: @hey-api/openapi-ts@<HEYAPI_VERSION> — see KNOWN_GAPS.md if upgrading
// Emits a TypeScript SDK npm package from a synthetic OpenAPI doc.
// Orchestrates Hey API codegen + 3 wedge plugins + Prettier + tsc gate.
// The wedge plugins are in ../sdk-plugins/{resource-tree,errors,runtime}.ts.
import type { CodegenOverlay } from "../overlays/codegen.js";

export interface RenderSdkInput {
  readonly oasJson: string;
  readonly productName: string;
  /**
   * Fully-resolved final destination for the emitted SDK tree.
   * The renderer does NOT append `/sdk/` or any product slug.
   * The caller pre-resolves (typically `join(skillDir, "sdk")`).
   */
  readonly outDir: string;
  readonly overlay: CodegenOverlay;
  readonly license?: string;
}

export interface SdkRenderResult {
  readonly outDir: string;
  readonly files: readonly string[];
  readonly typecheckExitCode: number;
}

export async function renderSdkPackage(
  input: RenderSdkInput,
): Promise<SdkRenderResult> {
  // Implementation lands in Task 7 (renderer wiring).
  // Skeleton present so plugin tasks can import the types.
  void input;
  throw new Error("renderSdkPackage: not implemented yet (skeleton)");
}
```

- [ ] **Step 2.4: Run test to verify it passes**

```bash
npx vitest run tests/renderers/sdk.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: both exit 0. Type surface compiles.

- [ ] **Step 2.5: Commit**

```bash
git add src/renderers/sdk.ts tests/renderers/sdk.test.ts
git commit -m "feat(renderer/sdk): scaffold renderSdkPackage type surface

Skeleton with RenderSdkInput / SdkRenderResult types and a
not-implemented body. Lets plugin tasks (T4-T6) import the types
without circular blockers. Implementation lands in Task 7.

outDir is contract-locked: fully-resolved final destination,
NOT a prefix the renderer further qualifies.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: SDK package templates

**Spec ref:** §5.3 (`src/renderers/sdk.ts` responsibility #3: write `package.json` / `tsconfig.json` / `README.md` / `LICENSE` / `.npmignore` templates).

**Files:**
- Create: `src/renderers/sdk-templates/package.json.tpl`
- Create: `src/renderers/sdk-templates/tsconfig.json.tpl`
- Create: `src/renderers/sdk-templates/README.md.tpl`
- Create: `src/renderers/sdk-templates/LICENSE.tpl`
- Create: `src/renderers/sdk-templates/npmignore.tpl`
- Create: `src/renderers/sdk-templates/render.ts` (template-loader helper)
- Create: `tests/renderers/sdk-templates.test.ts`

- [ ] **Step 3.1: Write the failing template-render test**

Create `tests/renderers/sdk-templates.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { renderTemplates, type TemplateContext } from "../../src/renderers/sdk-templates/render.js";

describe("renderTemplates", () => {
  const ctx: TemplateContext = {
    productName: "min.example",
    packageName: "@skillship/min-example-sdk",
    year: 2026,
    licenseHolder: "Firmis Labs",
  };

  test("emits five files keyed by their final on-disk names", () => {
    const out = renderTemplates(ctx);
    expect(Object.keys(out).sort()).toEqual([
      ".npmignore",
      "LICENSE",
      "README.md",
      "package.json",
      "tsconfig.json",
    ]);
  });

  test("package.json is valid JSON with strict ESM exports", () => {
    const out = renderTemplates(ctx);
    const pkg = JSON.parse(out["package.json"]!);
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("@skillship/min-example-sdk");
    expect(pkg.license).toBe("MIT");
    expect(pkg.main).toBeDefined();
    expect(pkg.types).toBeDefined();
    expect(pkg.exports).toBeDefined();
  });

  test("tsconfig.json is valid JSON with strict: true", () => {
    const out = renderTemplates(ctx);
    const tsc = JSON.parse(out["tsconfig.json"]!);
    expect(tsc.compilerOptions.strict).toBe(true);
    expect(tsc.compilerOptions.module).toMatch(/NodeNext/i);
  });

  test("LICENSE substitutes year and holder", () => {
    const out = renderTemplates(ctx);
    expect(out["LICENSE"]).toContain("2026");
    expect(out["LICENSE"]).toContain("Firmis Labs");
  });

  test("README mentions the product name", () => {
    const out = renderTemplates(ctx);
    expect(out["README.md"]).toContain("min.example");
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
npx vitest run tests/renderers/sdk-templates.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1` (module not found).

- [ ] **Step 3.3: Create the 5 template files**

Create `src/renderers/sdk-templates/package.json.tpl`:

```
{
  "name": "{{PACKAGE_NAME}}",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/firmislabs/{{PACKAGE_SLUG}}.git"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=20"
  }
}
```

Create `src/renderers/sdk-templates/tsconfig.json.tpl`:

```
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

Create `src/renderers/sdk-templates/README.md.tpl`:

```
# {{PACKAGE_NAME}}

Auto-generated TypeScript SDK for {{PRODUCT_NAME}}.

## Install

```sh
npm install {{PACKAGE_NAME}}
```

## Usage

```ts
import { Client } from "{{PACKAGE_NAME}}";

const client = new Client({
  baseUrl: "https://api.{{PRODUCT_NAME}}",
  auth: { kind: "bearer", token: process.env.API_TOKEN! },
});
```

Generated by [skillship](https://github.com/firmislabs/skillship).
```

Create `src/renderers/sdk-templates/LICENSE.tpl`:

```
MIT License

Copyright (c) {{YEAR}} {{HOLDER}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Create `src/renderers/sdk-templates/npmignore.tpl`:

```
node_modules/
src/
tsconfig.json
*.log
.DS_Store
```

- [ ] **Step 3.4: Create the template-loader helper**

Create `src/renderers/sdk-templates/render.ts`:

```typescript
// src/renderers/sdk-templates/render.ts
// Loads .tpl files from this directory and substitutes {{PLACEHOLDERS}}.
// Determinism: iteration over a fixed file list in fixed order.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface TemplateContext {
  readonly productName: string;
  readonly packageName: string;
  readonly year: number;
  readonly licenseHolder: string;
}

interface TemplateSpec {
  readonly tplFile: string;
  readonly outName: string;
}

const TEMPLATES: readonly TemplateSpec[] = [
  { tplFile: "package.json.tpl", outName: "package.json" },
  { tplFile: "tsconfig.json.tpl", outName: "tsconfig.json" },
  { tplFile: "README.md.tpl", outName: "README.md" },
  { tplFile: "LICENSE.tpl", outName: "LICENSE" },
  { tplFile: "npmignore.tpl", outName: ".npmignore" },
];

export function renderTemplates(
  ctx: TemplateContext,
): Record<string, string> {
  const slug = ctx.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const subs: Record<string, string> = {
    PACKAGE_NAME: ctx.packageName,
    PACKAGE_SLUG: slug,
    PRODUCT_NAME: ctx.productName,
    YEAR: String(ctx.year),
    HOLDER: ctx.licenseHolder,
  };
  const out: Record<string, string> = {};
  for (const spec of TEMPLATES) {
    const raw = readFileSync(join(HERE, spec.tplFile), "utf8");
    out[spec.outName] = applySubs(raw, subs);
  }
  return out;
}

function applySubs(raw: string, subs: Record<string, string>): string {
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const v = subs[key];
    if (v === undefined) throw new Error(`renderTemplates: missing substitution for ${key}`);
    return v;
  });
}
```

`renderTemplates` is 17 lines. `applySubs` is 6 lines. Both under the 50-line cap.

The default `tsconfig.json` excludes `src/renderers/sdk-templates/` content from compilation since `.tpl` files don't match `*.ts`. No additional config needed.

- [ ] **Step 3.5: Run tests + typecheck**

```bash
npx vitest run tests/renderers/sdk-templates.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: both exit 0. All 5 template tests pass.

- [ ] **Step 3.6: Verify build copies .tpl files into dist/**

The build script (`package.json` scripts.build) currently runs `tsc && cp src/graph/schema.sql dist/graph/schema.sql`. The `.tpl` files won't be copied to `dist/` by `tsc` since they aren't `.ts`. Without this fix, runtime will fail to find templates from the installed CLI.

Update `package.json` scripts.build:

```diff
- "build": "tsc && cp src/graph/schema.sql dist/graph/schema.sql",
+ "build": "tsc && cp src/graph/schema.sql dist/graph/schema.sql && mkdir -p dist/renderers/sdk-templates && cp src/renderers/sdk-templates/*.tpl dist/renderers/sdk-templates/",
```

Verify:

```bash
npm run build 2>&1 | tail -5; echo "BUILD_EXIT_CODE=$?"
ls dist/renderers/sdk-templates/ 2>&1
```

Expected: `BUILD_EXIT_CODE=0`; `dist/renderers/sdk-templates/` contains all 5 `.tpl` files.

- [ ] **Step 3.7: Commit**

```bash
git add src/renderers/sdk-templates/ tests/renderers/sdk-templates.test.ts package.json
git commit -m "feat(renderer/sdk): SDK package templates

Five .tpl files (package.json, tsconfig.json, README.md, LICENSE,
npmignore) with {{PLACEHOLDER}} substitution via renderTemplates.

The emitted package.json is type:'module' with ESM exports and an
exact-pinned engines.node>=20. The emitted tsconfig is strict:true
with NodeNext resolution and exactOptionalPropertyTypes.

Build script updated to copy .tpl files into dist/ alongside the
existing schema.sql copy.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Errors plugin

**Spec ref:** §5.3 (`src/sdk-plugins/errors.ts`).

**Files:**
- Create: `src/sdk-plugins/errors.ts`
- Create: `tests/sdk-plugins/errors.test.ts`

The errors plugin is the simplest (no dependency on overlay or auth), so it lands first.

- [ ] **Step 4.1: Write the failing test**

Create `tests/sdk-plugins/errors.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { generateErrorsModule, dispatchClassForStatus } from "../../src/sdk-plugins/errors.js";

describe("errors plugin", () => {
  test("generated module declares exactly the 7 classes", () => {
    const code = generateErrorsModule();
    const expected = [
      "export class APIError",
      "export class BadRequestError extends APIError",
      "export class UnauthorizedError extends APIError",
      "export class ForbiddenError extends APIError",
      "export class NotFoundError extends APIError",
      "export class RateLimitError extends APIError",
      "export class InternalServerError extends APIError",
    ];
    for (const decl of expected) {
      expect(code).toContain(decl);
    }
  });

  test("APIError exposes status, requestId, body, code props", () => {
    const code = generateErrorsModule();
    expect(code).toMatch(/readonly status:\s*number/);
    expect(code).toMatch(/readonly requestId:\s*string \| null/);
    expect(code).toMatch(/readonly body:\s*unknown/);
    expect(code).toMatch(/readonly code:\s*string \| null/);
  });

  test("dispatchClassForStatus maps each declared status to its class", () => {
    expect(dispatchClassForStatus(400)).toBe("BadRequestError");
    expect(dispatchClassForStatus(401)).toBe("UnauthorizedError");
    expect(dispatchClassForStatus(403)).toBe("ForbiddenError");
    expect(dispatchClassForStatus(404)).toBe("NotFoundError");
    expect(dispatchClassForStatus(429)).toBe("RateLimitError");
    expect(dispatchClassForStatus(500)).toBe("InternalServerError");
    expect(dispatchClassForStatus(503)).toBe("InternalServerError");
    expect(dispatchClassForStatus(599)).toBe("InternalServerError");
  });

  test("dispatchClassForStatus falls back to APIError for unrecognized codes", () => {
    expect(dispatchClassForStatus(418)).toBe("APIError");
    expect(dispatchClassForStatus(302)).toBe("APIError");
    expect(dispatchClassForStatus(700)).toBe("APIError");
  });
});
```

- [ ] **Step 4.2: Run test to verify it fails**

```bash
npx vitest run tests/sdk-plugins/errors.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1` (module not found).

- [ ] **Step 4.3: Implement `src/sdk-plugins/errors.ts`**

Create `src/sdk-plugins/errors.ts`:

```typescript
// src/sdk-plugins/errors.ts
// Hey API custom plugin: emits a typed error hierarchy and patches the
// SDK transport so non-2xx responses throw the right class.
//
// The plugin contract (factory shape, output dir, hooks) follows
// @hey-api/openapi-ts plugin authoring — see the SDK comment in
// src/renderers/sdk.ts for the pinned version.

const ERRORS_MODULE_SOURCE = `// Auto-generated by @skillship/sdk-plugin-errors. Do not edit by hand.

export class APIError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly body: unknown;
  readonly code: string | null;
  constructor(args: { status: number; requestId: string | null; body: unknown; code: string | null; message: string }) {
    super(args.message);
    this.name = "APIError";
    this.status = args.status;
    this.requestId = args.requestId;
    this.body = args.body;
    this.code = args.code;
  }
}

export class BadRequestError extends APIError { constructor(a: ConstructorParameters<typeof APIError>[0]) { super(a); this.name = "BadRequestError"; } }
export class UnauthorizedError extends APIError { constructor(a: ConstructorParameters<typeof APIError>[0]) { super(a); this.name = "UnauthorizedError"; } }
export class ForbiddenError extends APIError { constructor(a: ConstructorParameters<typeof APIError>[0]) { super(a); this.name = "ForbiddenError"; } }
export class NotFoundError extends APIError { constructor(a: ConstructorParameters<typeof APIError>[0]) { super(a); this.name = "NotFoundError"; } }
export class RateLimitError extends APIError { constructor(a: ConstructorParameters<typeof APIError>[0]) { super(a); this.name = "RateLimitError"; } }
export class InternalServerError extends APIError { constructor(a: ConstructorParameters<typeof APIError>[0]) { super(a); this.name = "InternalServerError"; } }

export function throwForResponse(args: { status: number; requestId: string | null; body: unknown; code: string | null }): never {
  const message = "API error " + String(args.status);
  switch (args.status) {
    case 400: throw new BadRequestError({ ...args, message });
    case 401: throw new UnauthorizedError({ ...args, message });
    case 403: throw new ForbiddenError({ ...args, message });
    case 404: throw new NotFoundError({ ...args, message });
    case 429: throw new RateLimitError({ ...args, message });
    default:
      if (args.status >= 500 && args.status <= 599) throw new InternalServerError({ ...args, message });
      throw new APIError({ ...args, message });
  }
}
`;

export function generateErrorsModule(): string {
  return ERRORS_MODULE_SOURCE;
}

export function dispatchClassForStatus(status: number): string {
  if (status === 400) return "BadRequestError";
  if (status === 401) return "UnauthorizedError";
  if (status === 403) return "ForbiddenError";
  if (status === 404) return "NotFoundError";
  if (status === 429) return "RateLimitError";
  if (status >= 500 && status <= 599) return "InternalServerError";
  return "APIError";
}

/**
 * Hey API plugin factory. The exact return shape is dictated by
 * @hey-api/openapi-ts's plugin authoring API at the pinned version.
 * Returns a plugin object the engine consumes during codegen.
 *
 * Implementation note: the factory just hands the engine the
 * `generateErrorsModule()` string and a single output filename
 * (`errors.ts`). The plugin contributes no other emit; the SDK
 * transport (emitted by `src/sdk-plugins/runtime.ts`) imports
 * `throwForResponse` from this file when handling non-2xx responses.
 */
export function errorsPlugin(): unknown {
  return {
    name: "@skillship/sdk-errors",
    output: "errors",
    handler: () => generateErrorsModule(),
  };
}
```

`generateErrorsModule` and `dispatchClassForStatus` are both pure functions (testable without invoking Hey API). The plugin factory shape (`errorsPlugin`) is a thin wrapper that the renderer hands to Hey API at runtime.

- [ ] **Step 4.4: Run test + typecheck**

```bash
npx vitest run tests/sdk-plugins/errors.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: both exit 0.

- [ ] **Step 4.5: Commit**

```bash
git add src/sdk-plugins/errors.ts tests/sdk-plugins/errors.test.ts
git commit -m "feat(sdk-plugin/errors): 7-class typed error hierarchy

Emits APIError base + 6 subclasses (BadRequest, Unauthorized,
Forbidden, NotFound, RateLimit, InternalServer). dispatchClassForStatus
maps status codes; throwForResponse switches on status and throws
the right class. 500-599 all map to InternalServerError; unknown
statuses fall back to APIError.

Plugin factory (errorsPlugin) is a thin wrapper around the
generateErrorsModule pure function. Unit-testing the pure function
keeps coverage decoupled from Hey API engine behavior.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Runtime plugin

**Spec ref:** §5.3 (`src/sdk-plugins/runtime.ts`).

**Files:**
- Create: `src/sdk-plugins/runtime.ts`
- Create: `tests/sdk-plugins/runtime.test.ts`

The runtime plugin owns the `Client` constructor and auth injection. It depends on `securitySchemes` from the OAS doc, NOT on overlay rules.

- [ ] **Step 5.1: Write the failing test**

Create `tests/sdk-plugins/runtime.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { generateRuntimeModule, type AuthSchemeDescriptor } from "../../src/sdk-plugins/runtime.js";

describe("runtime plugin", () => {
  const bearerOnly: readonly AuthSchemeDescriptor[] = [{ kind: "bearer", id: "bearer_main" }];

  test("emits a Client class with declared constructor signature", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toMatch(/export class Client/);
    expect(code).toMatch(/constructor\(opts:\s*ClientOptions\)/);
    expect(code).toMatch(/baseUrl:\s*string/);
    expect(code).toMatch(/auth:\s*AuthConfig/);
    expect(code).toMatch(/defaultHeaders\?\:\s*Record<string,\s*string>/);
    expect(code).toMatch(/fetch\?\:\s*typeof fetch/);
    expect(code).toMatch(/timeout\?\:\s*number/);
  });

  test("AuthConfig is a discriminated union of the projected schemes", () => {
    const code = generateRuntimeModule([
      { kind: "bearer", id: "b1" },
      { kind: "apiKey", id: "k1", in: "header", name: "X-API-Key" },
      { kind: "basic", id: "ba1" },
    ]);
    expect(code).toContain('{ kind: "bearer"; token: string }');
    expect(code).toContain('{ kind: "apiKey"; value: string; in: "header" | "query"; name: string }');
    expect(code).toContain('{ kind: "basic"; username: string; password: string }');
  });

  test("emits onRequest and onResponse interceptor hooks", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toContain("onRequest");
    expect(code).toContain("onResponse");
  });

  test("injects Authorization Bearer header when auth.kind === 'bearer'", () => {
    const code = generateRuntimeModule(bearerOnly);
    expect(code).toMatch(/"Authorization":\s*`Bearer\s*\${[^}]+}`/);
  });

  test("injects apiKey into header or query per the 'in' field", () => {
    const code = generateRuntimeModule([{ kind: "apiKey", id: "k1", in: "header", name: "X-API-Key" }]);
    // apiKey-header branch produces a headers[name] = value assignment
    expect(code).toMatch(/headers\[[^\]]+\]\s*=\s*[^;]*value/);
    // apiKey-query branch produces a URLSearchParams append
    expect(code).toMatch(/searchParams\.append\(/);
  });

  test("emitting with empty schemes still produces a working Client (no auth case)", () => {
    const code = generateRuntimeModule([]);
    expect(code).toMatch(/export class Client/);
    // AuthConfig must still type-check (use 'never' or an open union sentinel)
    expect(code).toMatch(/export type AuthConfig/);
  });
});
```

- [ ] **Step 5.2: Run test to verify it fails**

```bash
npx vitest run tests/sdk-plugins/runtime.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1`.

- [ ] **Step 5.3: Implement `src/sdk-plugins/runtime.ts`**

Create `src/sdk-plugins/runtime.ts`:

```typescript
// src/sdk-plugins/runtime.ts
// Hey API custom plugin: emits the Client class, fetch wrapper, and
// auth-injection logic. Auth schemes are projected from the synthetic
// OpenAPI's components.securitySchemes (via Plan 1/1.5 substrate).
//
// No retries / no backoff / no idempotency-key in Plan 2 — see spec §5.3
// and §5.10. Those land in Plan 2b with the retries plugin.

export type AuthSchemeDescriptor =
  | { readonly kind: "bearer"; readonly id: string }
  | { readonly kind: "apiKey"; readonly id: string; readonly in: "header" | "query"; readonly name: string }
  | { readonly kind: "basic"; readonly id: string };

export function generateRuntimeModule(schemes: readonly AuthSchemeDescriptor[]): string {
  const authUnion = buildAuthUnion(schemes);
  const injectBody = buildInjectBody(schemes);
  return `// Auto-generated by @skillship/sdk-plugin-runtime. Do not edit by hand.
import { throwForResponse } from "./errors.js";

export type AuthConfig = ${authUnion};

export interface ClientOptions {
  baseUrl: string;
  auth: AuthConfig;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  timeout?: number;
  onRequest?: (req: Request) => Request | Promise<Request>;
  onResponse?: (res: Response) => Response | Promise<Response>;
}

export class Client {
  readonly baseUrl: string;
  readonly auth: AuthConfig;
  readonly defaultHeaders: Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly timeout: number | undefined;
  readonly onRequest: ((req: Request) => Request | Promise<Request>) | undefined;
  readonly onResponse: ((res: Response) => Response | Promise<Response>) | undefined;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\\/+$/, "");
    this.auth = opts.auth;
    this.defaultHeaders = opts.defaultHeaders ?? {};
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.timeout = opts.timeout;
    this.onRequest = opts.onRequest;
    this.onResponse = opts.onResponse;
  }

  async request(input: { path: string; method: string; query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string> }): Promise<Response> {
    const url = new URL(this.baseUrl + input.path);
    if (input.query) {
      for (const [k, v] of Object.entries(input.query)) {
        if (v !== undefined) url.searchParams.append(k, String(v));
      }
    }
    const headers: Record<string, string> = { ...this.defaultHeaders, ...(input.headers ?? {}) };
    const searchParams = url.searchParams;
${injectBody}
    const init: RequestInit = { method: input.method, headers };
    if (input.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      init.body = JSON.stringify(input.body);
    }
    let req = new Request(url.toString(), init);
    if (this.onRequest) req = await this.onRequest(req);
    let res = await this.fetchImpl(req);
    if (this.onResponse) res = await this.onResponse(res);
    if (!res.ok) {
      const requestId = res.headers.get("x-request-id");
      let body: unknown = null;
      try { body = await res.clone().json(); } catch { try { body = await res.clone().text(); } catch { /* ignore */ } }
      throwForResponse({ status: res.status, requestId, body, code: null });
    }
    return res;
  }
}
`;
}

function buildAuthUnion(schemes: readonly AuthSchemeDescriptor[]): string {
  if (schemes.length === 0) return 'never & { __skillshipNoAuth: true }';
  const parts = new Set<string>();
  for (const s of schemes) {
    if (s.kind === "bearer") parts.add('{ kind: "bearer"; token: string }');
    if (s.kind === "apiKey") parts.add('{ kind: "apiKey"; value: string; in: "header" | "query"; name: string }');
    if (s.kind === "basic") parts.add('{ kind: "basic"; username: string; password: string }');
  }
  return [...parts].sort().join(" | ");
}

function buildInjectBody(schemes: readonly AuthSchemeDescriptor[]): string {
  if (schemes.length === 0) return "    // no auth schemes projected";
  const lines: string[] = [];
  lines.push('    if (this.auth.kind === "bearer") {');
  lines.push('      headers["Authorization"] = `Bearer ${this.auth.token}`;');
  lines.push('    }');
  if (schemes.some((s) => s.kind === "apiKey")) {
    lines.push('    if (this.auth.kind === "apiKey") {');
    lines.push('      const value = this.auth.value;');
    lines.push('      if (this.auth.in === "header") headers[this.auth.name] = value;');
    lines.push('      else searchParams.append(this.auth.name, value);');
    lines.push('    }');
  }
  if (schemes.some((s) => s.kind === "basic")) {
    lines.push('    if (this.auth.kind === "basic") {');
    lines.push('      const encoded = Buffer.from(`${this.auth.username}:${this.auth.password}`).toString("base64");');
    lines.push('      headers["Authorization"] = `Basic ${encoded}`;');
    lines.push('    }');
  }
  return lines.join("\n");
}

export function runtimePlugin(schemes: readonly AuthSchemeDescriptor[]): unknown {
  return {
    name: "@skillship/sdk-runtime",
    output: "runtime",
    handler: () => generateRuntimeModule(schemes),
  };
}
```

`generateRuntimeModule` is 39 lines (under cap). `buildAuthUnion` is 8 lines. `buildInjectBody` is 22 lines. `runtimePlugin` factory is 6 lines.

- [ ] **Step 5.4: Run test + typecheck**

```bash
npx vitest run tests/sdk-plugins/runtime.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: both exit 0.

- [ ] **Step 5.5: Commit**

```bash
git add src/sdk-plugins/runtime.ts tests/sdk-plugins/runtime.test.ts
git commit -m "feat(sdk-plugin/runtime): Client class + fetch wrapper + auth injection

Emits the Client class with declarative AuthConfig discriminated union
driven by projected securitySchemes. Bearer auth sets the Authorization
header; apiKey sets either a header or a URLSearchParams entry per the
'in' field; basic encodes user:pass as base64 Authorization.

onRequest / onResponse interceptors exposed for advanced users. No
retries / no backoff / no idempotency in Plan 2 (deferred to Plan 2b
with the retries plugin per spec §5.10).

Non-2xx responses route through throwForResponse (errors.ts) carrying
status + x-request-id + parsed body + code.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Resource-tree plugin

**Spec ref:** §5.3 (`src/sdk-plugins/resource-tree.ts`).

**Files:**
- Create: `src/sdk-plugins/resource-tree.ts`
- Create: `tests/sdk-plugins/resource-tree.test.ts`

The resource-tree plugin reshapes flat operations into nested namespaces. Data source: the `CodegenOverlay` object passed through the plugin factory closure (per locked spec §5.3 — `x-skillship-codegen` is informational and NOT re-parsed by the plugin).

- [ ] **Step 6.1: Write the failing test**

Create `tests/sdk-plugins/resource-tree.test.ts`:

```typescript
import { describe, expect, test } from "vitest";
import { buildNamespaceTree, type OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
import type { CodegenOverlay } from "../../src/overlays/codegen.js";

const EMPTY_OVERLAY: CodegenOverlay = { resources: {}, streaming: [] };

describe("resource-tree plugin", () => {
  test("places ops under tags[0] when no overlay rule matches", () => {
    const ops: OperationInfo[] = [
      { operationId: "listProjects", tags: ["projects"] },
      { operationId: "createProject", tags: ["projects"] },
      { operationId: "listUsers", tags: ["users"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({
      projects: ["listProjects", "createProject"],
      users: ["listUsers"],
    });
  });

  test("overlay rename rewrites the leaf method name", () => {
    const ops: OperationInfo[] = [
      { operationId: "listProjects", tags: ["projects"] },
    ];
    const overlay: CodegenOverlay = {
      resources: { listProjects: { namespace: "projects", rename: "list" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    expect(tree).toEqual({ projects: ["list"] });
  });

  test("overlay namespace overrides tags[0]", () => {
    const ops: OperationInfo[] = [
      { operationId: "issueCreate", tags: ["mutation"] },
    ];
    const overlay: CodegenOverlay = {
      resources: { issueCreate: { namespace: "issues" } },
      streaming: [],
    };
    const tree = buildNamespaceTree(ops, overlay);
    expect(tree).toEqual({ issues: ["issueCreate"] });
  });

  test("falls back to 'default' when no tags[0] and no overlay rule", () => {
    const ops: OperationInfo[] = [
      { operationId: "ping", tags: [] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(tree).toEqual({ default: ["ping"] });
  });

  test("deterministic ordering: namespaces sorted, methods preserved in input order", () => {
    const ops: OperationInfo[] = [
      { operationId: "z_first", tags: ["zulu"] },
      { operationId: "a_second", tags: ["alpha"] },
      { operationId: "a_first", tags: ["alpha"] },
    ];
    const tree = buildNamespaceTree(ops, EMPTY_OVERLAY);
    expect(Object.keys(tree)).toEqual(["alpha", "zulu"]);
    expect(tree.alpha).toEqual(["a_second", "a_first"]);
  });
});
```

- [ ] **Step 6.2: Run test to verify it fails**

```bash
npx vitest run tests/sdk-plugins/resource-tree.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1`.

- [ ] **Step 6.3: Implement `src/sdk-plugins/resource-tree.ts`**

Create `src/sdk-plugins/resource-tree.ts`:

```typescript
// src/sdk-plugins/resource-tree.ts
// Hey API custom plugin: reshapes generated client into nested namespaces.
//
// Data source contract (locked in spec §5.3):
//   The plugin reads resources rename/namespace rules from the CodegenOverlay
//   object passed through the plugin factory closure. The x-skillship-codegen
//   vendor extension on the OAS doc is INFORMATIONAL and NOT re-parsed here.
//   Single source of truth: the CodegenOverlay Zod-validated object.
//
// Fallback when no overlay rule matches: use the operation's tags[0],
// which R-OAS derives from the REST path's first non-template segment
// or the GraphQL root type (per renderers/oas.ts buildTags).
//
// If tags[0] is also absent, the op lands under "default".
import type { CodegenOverlay } from "../overlays/codegen.js";

export interface OperationInfo {
  readonly operationId: string;
  readonly tags: readonly string[];
}

export function buildNamespaceTree(
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): Record<string, string[]> {
  const tree: Record<string, string[]> = {};
  for (const op of ops) {
    const rule = overlay.resources[op.operationId];
    const namespace = rule?.namespace ?? op.tags[0] ?? "default";
    const methodName = rule?.rename ?? op.operationId;
    (tree[namespace] ??= []).push(methodName);
  }
  const sorted: Record<string, string[]> = {};
  for (const k of Object.keys(tree).sort()) sorted[k] = tree[k]!;
  return sorted;
}

/**
 * Generates the index.ts content that re-exports flat SDK functions
 * under nested namespaces. The flat functions come from
 * @hey-api/sdk's emit. We wire them into a Client extension:
 *
 *   client.projects.list(...) → calls listProjects(...)
 *
 * @param tree     The namespace tree from buildNamespaceTree.
 * @param hyaPath  The relative import path to the flat SDK module
 *                 emitted by @hey-api/sdk (typically "./sdk.gen.js").
 */
export function generateResourceTreeModule(
  tree: Record<string, string[]>,
  hyaPath: string,
): string {
  const lines: string[] = [];
  lines.push("// Auto-generated by @skillship/sdk-plugin-resource-tree. Do not edit by hand.");
  lines.push(`import * as flat from "${hyaPath}";`);
  lines.push(`import { Client } from "./runtime.js";`);
  lines.push("");
  lines.push("export interface ResourceTree {");
  for (const ns of Object.keys(tree)) {
    lines.push(`  readonly ${ns}: { ${tree[ns]!.map(m => `${m}: typeof flat.${m}`).join("; ")} };`);
  }
  lines.push("}");
  lines.push("");
  lines.push("export function attachResources(client: Client): Client & ResourceTree {");
  lines.push("  return Object.assign(client, {");
  for (const ns of Object.keys(tree)) {
    lines.push(`    ${ns}: { ${tree[ns]!.map(m => `${m}: flat.${m}`).join(", ")} },`);
  }
  lines.push("  });");
  lines.push("}");
  return lines.join("\n") + "\n";
}

export function resourceTreePlugin(overlay: CodegenOverlay): unknown {
  return {
    name: "@skillship/sdk-resource-tree",
    output: "resources",
    handler: (ctx: { operations: readonly OperationInfo[] }) => {
      const tree = buildNamespaceTree(ctx.operations, overlay);
      return generateResourceTreeModule(tree, "./sdk.gen.js");
    },
  };
}
```

`buildNamespaceTree` is 12 lines. `generateResourceTreeModule` is 20 lines. `resourceTreePlugin` is 9 lines. All under cap.

- [ ] **Step 6.4: Run test + typecheck**

```bash
npx vitest run tests/sdk-plugins/resource-tree.test.ts 2>&1 | tail -10; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: both exit 0.

- [ ] **Step 6.5: Commit**

```bash
git add src/sdk-plugins/resource-tree.ts tests/sdk-plugins/resource-tree.test.ts
git commit -m "feat(sdk-plugin/resource-tree): nested namespace reshaping

Reads CodegenOverlay.resources rules. Each op maps to:
- namespace from rule.namespace, fallback to tags[0], fallback to 'default'
- method name from rule.rename, fallback to operationId

x-skillship-codegen vendor extension is informational only — NOT
re-parsed by this plugin (locked in spec §5.3 data-source contract).

Output reshapes flat SDK functions into nested client.namespace.method
via Object.assign-based augmentation; the Client class stays the
single canonical type.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Renderer wiring — full `renderSdkPackage` body

**Spec ref:** §5.3 (`src/renderers/sdk.ts` responsibilities), §5.4 (data flow), §5.6 (error handling), §5.7 (determinism test).

**Files:**
- Modify: `src/renderers/sdk.ts` (implement the body)
- Modify: `tests/renderers/sdk.test.ts` (add determinism + integration tests)

- [ ] **Step 7.1: Extend the test with a determinism check**

Append to `tests/renderers/sdk.test.ts`:

```typescript
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderSdkPackage } from "../../src/renderers/sdk.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const sub of listFilesRecursive(full)) out.push(join(name, sub));
    } else {
      out.push(name);
    }
  }
  return out;
}

const MINIMAL_OAS = JSON.stringify({
  openapi: "3.1.0",
  info: { title: "min.example", version: "1.0.0" },
  paths: {
    "/projects": {
      get: {
        operationId: "listProjects",
        responses: { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } },
        security: [{ bearer_main: [] }],
        tags: ["projects"],
      },
    },
  },
  components: {
    schemas: {},
    securitySchemes: { bearer_main: { type: "http", scheme: "bearer" } },
  },
}, null, 2);

describe("renderSdkPackage — integration", () => {
  test("emits a package tree with package.json, tsconfig.json, src/, and a 0 typecheck exit", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "sk-sdk-A-"));
    try {
      const result = await renderSdkPackage({
        oasJson: MINIMAL_OAS,
        productName: "min.example",
        outDir: tmpA,
        overlay: CodegenOverlaySchema.parse({}),
      });
      expect(result.typecheckExitCode).toBe(0);
      const files = listFilesRecursive(tmpA).sort();
      expect(files).toContain("package.json");
      expect(files).toContain("tsconfig.json");
      expect(files).toContain("README.md");
      expect(files).toContain("LICENSE");
      expect(files).toContain(".npmignore");
      // The 3 wedge plugins each contribute exactly one .ts file under src/
      expect(files.some((f) => f.startsWith("src/") && f.endsWith("errors.ts"))).toBe(true);
      expect(files.some((f) => f.startsWith("src/") && f.endsWith("runtime.ts"))).toBe(true);
      expect(files.some((f) => f.startsWith("src/") && f.endsWith("resources.ts"))).toBe(true);
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
    }
  }, 30000);

  test("two consecutive renders produce byte-identical trees", async () => {
    const tmpA = mkdtempSync(join(tmpdir(), "sk-sdk-det-A-"));
    const tmpB = mkdtempSync(join(tmpdir(), "sk-sdk-det-B-"));
    try {
      await renderSdkPackage({ oasJson: MINIMAL_OAS, productName: "min.example", outDir: tmpA, overlay: CodegenOverlaySchema.parse({}) });
      await renderSdkPackage({ oasJson: MINIMAL_OAS, productName: "min.example", outDir: tmpB, overlay: CodegenOverlaySchema.parse({}) });
      const filesA = listFilesRecursive(tmpA).sort();
      const filesB = listFilesRecursive(tmpB).sort();
      expect(filesB).toEqual(filesA);
      for (const f of filesA) {
        expect(readFileSync(join(tmpB, f), "utf8"), `mismatch in ${f}`).toBe(readFileSync(join(tmpA, f), "utf8"));
      }
    } finally {
      rmSync(tmpA, { recursive: true, force: true });
      rmSync(tmpB, { recursive: true, force: true });
    }
  }, 60000);

  test("leaves outDir untouched on typecheck failure (atomic guarantee)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-fail-"));
    const outDir = join(tmp, "sdk");
    // Force a tsc failure by injecting an invalid OAS that produces uncompilable output.
    // Approach: feed an OAS whose schema_ref points to a non-existent component,
    // which causes the Hey API generator to reference an undefined type.
    const brokenOas = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "broken", version: "1.0.0" },
      paths: { "/x": { get: { operationId: "x", responses: { "200": { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Missing" } } } } } } } },
      components: { schemas: {}, securitySchemes: {} },
    }, null, 2);
    try {
      await expect(renderSdkPackage({ oasJson: brokenOas, productName: "broken", outDir, overlay: CodegenOverlaySchema.parse({}) })).rejects.toThrow();
      // outDir should not exist
      expect(() => statSync(outDir)).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);
});
```

- [ ] **Step 7.2: Run tests to verify they fail**

```bash
npx vitest run tests/renderers/sdk.test.ts 2>&1 | tail -20; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1`. `renderSdkPackage` currently throws "not implemented yet".

- [ ] **Step 7.3: Implement the renderer body**

Replace the skeleton body of `src/renderers/sdk.ts`. Replace the entire file contents:

```typescript
// src/renderers/sdk.ts
// pinned: @hey-api/openapi-ts@<HEYAPI_VERSION> — see KNOWN_GAPS.md if upgrading
// Emits a TypeScript SDK npm package from a synthetic OpenAPI doc.
// Pipeline: temp-write OAS → run Hey API codegen + 3 wedge plugins
//   → write package templates → Prettier-format → run tsc --noEmit gate
//   → atomic-rename temp → final outDir.
// On ANY failure, the final outDir is left untouched (atomic guarantee).
import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type { CodegenOverlay } from "../overlays/codegen.js";
import { errorsPlugin } from "../sdk-plugins/errors.js";
import { runtimePlugin, type AuthSchemeDescriptor } from "../sdk-plugins/runtime.js";
import { resourceTreePlugin } from "../sdk-plugins/resource-tree.js";
import { renderTemplates } from "./sdk-templates/render.js";

const execFileP = promisify(execFile);

export interface RenderSdkInput {
  readonly oasJson: string;
  readonly productName: string;
  readonly outDir: string;
  readonly overlay: CodegenOverlay;
  readonly license?: string;
}

export interface SdkRenderResult {
  readonly outDir: string;
  readonly files: readonly string[];
  readonly typecheckExitCode: number;
}

export async function renderSdkPackage(
  input: RenderSdkInput,
): Promise<SdkRenderResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "sk-sdk-"));
  try {
    const oasPath = writeOasToTemp(input.oasJson, tempDir);
    const schemes = extractAuthSchemes(input.oasJson);
    await runHeyApiCodegen(oasPath, tempDir, input.overlay, schemes);
    writePackageTemplates(tempDir, input);
    await formatWithPrettier(tempDir);
    const exitCode = await runTypecheckGate(tempDir);
    if (exitCode !== 0) {
      throw new Error(`renderSdkPackage: tsc --noEmit exited ${exitCode}`);
    }
    atomicMove(tempDir, input.outDir);
    const files = listEmittedFiles(input.outDir);
    return { outDir: input.outDir, files, typecheckExitCode: 0 };
  } catch (err) {
    rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }
}

function writeOasToTemp(oasJson: string, tempDir: string): string {
  const oasPath = join(tempDir, "openapi.json");
  writeFileSync(oasPath, oasJson, "utf8");
  return oasPath;
}

interface OasComponents {
  readonly securitySchemes?: Record<string, Record<string, unknown>>;
}
interface OasDoc {
  readonly components?: OasComponents;
}

function extractAuthSchemes(oasJson: string): readonly AuthSchemeDescriptor[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const schemes = doc.components?.securitySchemes ?? {};
  const out: AuthSchemeDescriptor[] = [];
  for (const id of Object.keys(schemes).sort()) {
    const s = schemes[id]!;
    if (s.type === "http" && s.scheme === "bearer") out.push({ kind: "bearer", id });
    else if (s.type === "http" && s.scheme === "basic") out.push({ kind: "basic", id });
    else if (s.type === "apiKey") {
      const loc = s.in === "query" ? "query" : "header";
      const name = typeof s.name === "string" ? s.name : "Authorization";
      out.push({ kind: "apiKey", id, in: loc, name });
    }
  }
  return out;
}

async function runHeyApiCodegen(
  oasPath: string,
  tempDir: string,
  overlay: CodegenOverlay,
  schemes: readonly AuthSchemeDescriptor[],
): Promise<void> {
  // Invoke @hey-api/openapi-ts programmatically. Exact API surface
  // dictated by the pinned version; verify against
  // node_modules/@hey-api/openapi-ts/dist/index.d.ts before edits.
  const heyApi = await import("@hey-api/openapi-ts");
  const createConfig = (heyApi as { createConfig?: (cfg: unknown) => unknown }).createConfig
    ?? ((cfg: unknown) => cfg);
  const cfg = createConfig({
    input: oasPath,
    output: { path: join(tempDir, "src"), format: false },
    plugins: [
      "@hey-api/typescript",
      "@hey-api/sdk",
      errorsPlugin(),
      runtimePlugin(schemes),
      resourceTreePlugin(overlay),
    ],
  });
  const generator = (heyApi as { createClient?: (cfg: unknown) => Promise<unknown> }).createClient;
  if (typeof generator !== "function") {
    throw new Error("renderSdkPackage: Hey API engine missing expected createClient export");
  }
  await generator(cfg);
}

function writePackageTemplates(tempDir: string, input: RenderSdkInput): void {
  const slug = slugify(input.productName);
  const tplOut = renderTemplates({
    productName: input.productName,
    packageName: `@skillship/${slug}-sdk`,
    year: 2026,
    licenseHolder: "Firmis Labs",
  });
  for (const [name, content] of Object.entries(tplOut)) {
    writeFileSync(join(tempDir, name), content, "utf8");
  }
}

async function formatWithPrettier(tempDir: string): Promise<void> {
  const prettier = await import("prettier");
  const fmt = prettier.format ?? (prettier.default as { format: typeof prettier.format }).format;
  for (const file of walkTs(tempDir)) {
    const src = readFileSync(file, "utf8");
    const formatted = await fmt(src, { parser: "typescript", semi: true, singleQuote: false });
    writeFileSync(file, formatted, "utf8");
  }
}

function* walkTs(dir: string): IterableIterator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

async function runTypecheckGate(tempDir: string): Promise<number> {
  // Use the project-local tsc to typecheck the emitted package.
  const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
  try {
    await execFileP(tscBin, ["--noEmit", "-p", tempDir]);
    return 0;
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    process.stderr.write(`renderSdkPackage tsc stdout:\n${e.stdout ?? ""}\nstderr:\n${e.stderr ?? ""}\n`);
    return typeof e.code === "number" ? e.code : 1;
  }
}

function atomicMove(tempDir: string, outDir: string): void {
  mkdirSync(dirname(outDir), { recursive: true });
  if (statSyncSafe(outDir)) rmSync(outDir, { recursive: true, force: true });
  renameSync(tempDir, outDir);
}

function statSyncSafe(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

function listEmittedFiles(outDir: string): readonly string[] {
  const out: string[] = [];
  for (const f of walkAll(outDir)) out.push(relative(outDir, f));
  return out.sort();
}

function* walkAll(dir: string): IterableIterator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkAll(full);
    else yield full;
  }
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
```

**Note on Hey API API surface:** the exact import names (`createConfig`, `createClient`, plugin shape) may differ from what's written above at the pinned version. The implementer MUST verify against `node_modules/@hey-api/openapi-ts/dist/index.d.ts` and adjust function names accordingly. If the API differs materially, document the binding in a comment block above `runHeyApiCodegen` and update the type assertions. The spec acknowledges this in §5.9 R2-1.

**Function size check:** all functions are ≤50 lines. `renderSdkPackage` body is 16 lines, `runHeyApiCodegen` is 19, `extractAuthSchemes` is 14, others under 10.

- [ ] **Step 7.4: Run tests**

```bash
npx vitest run tests/renderers/sdk.test.ts 2>&1 | tail -40; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: all 5 tests pass (skeleton tests + 3 integration tests), TSC_EXIT_CODE=0. If the Hey API engine import shape differs, this is where the implementer adjusts (loop with the engine docs until tests green).

- [ ] **Step 7.5: Commit**

```bash
git add src/renderers/sdk.ts tests/renderers/sdk.test.ts
git commit -m "feat(renderer/sdk): full renderSdkPackage implementation

Orchestrates the 6-step pipeline:
1. temp-write OAS doc
2. invoke @hey-api/openapi-ts with 3 wedge plugins
3. write package.json/tsconfig.json/README.md/LICENSE/.npmignore
4. format emitted TS with prettier
5. run tsc --noEmit against the temp package
6. on exit 0, atomic-rename temp → input.outDir

Functions split for the 50-line cap. The Hey API plugin contract
matches the pinned version (see comment block); if upgrading the
pin, verify against node_modules/@hey-api/openapi-ts/dist/index.d.ts.

Atomic guarantee verified by test: tsc failure leaves outDir absent.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 8: CLI wiring + `--skip-sdk` flag

**Spec ref:** §5.3 (`src/cli/build.ts` wiring), §5.5 (success criteria 8: `--skip-sdk` short-circuits).

**Files:**
- Modify: `src/cli/build.ts`
- Modify: `src/cli/index.ts`
- Create: `tests/cli/build-sdk.test.ts`

- [ ] **Step 8.1: Write the failing build-wiring test**

Create `tests/cli/build-sdk.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runBuild } from "../../src/cli/build.js";

const FIXTURE_SPEC = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"), "utf8");

function stageProject(): { inDir: string; outDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sk-build-sdk-"));
  const inDir = join(root, "in");
  const outDir = join(root, "out");
  mkdirSync(join(inDir, ".skillship/sources"), { recursive: true });
  writeFileSync(join(inDir, ".skillship/config.yaml"), `
product:
  domain: min.example
  github_org: null
sources:
  - url: https://min.example/openapi.yaml
    surface: rest
    sha256: <placeholder>
    content_type: application/openapi+yaml
    fetched_at: 2026-05-20T00:00:00.000Z
coverage: bronze
`.trim() + "\n", "utf8");
  // The build pipeline computes sha256 of the source file at ingest. We pre-write the
  // source bytes under the same sha256 the pipeline will look for, then patch config.
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const sha = crypto.createHash("sha256").update(FIXTURE_SPEC).digest("hex");
  writeFileSync(join(inDir, ".skillship/sources", `${sha}.yaml`), FIXTURE_SPEC, "utf8");
  let cfg = readFileSync(join(inDir, ".skillship/config.yaml"), "utf8");
  cfg = cfg.replace("<placeholder>", sha);
  writeFileSync(join(inDir, ".skillship/config.yaml"), cfg, "utf8");
  return {
    inDir,
    outDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("runBuild — SDK emission", () => {
  test("emits {outDir}/{product-slug}/sdk/ with package.json by default", async () => {
    const { inDir, outDir, cleanup } = stageProject();
    try {
      const result = await runBuild({ in: inDir, out: outDir });
      const sdkDir = join(outDir, "min-example", "sdk");
      const pkgPath = join(sdkDir, "package.json");
      expect(statSync(pkgPath).isFile()).toBe(true);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      expect(pkg.type).toBe("module");
      expect(result.artifacts.some((a) => a.path === pkgPath)).toBe(true);
    } finally {
      cleanup();
    }
  }, 60000);

  test("--skip-sdk short-circuits SDK emission without affecting other artifacts", async () => {
    const { inDir, outDir, cleanup } = stageProject();
    try {
      const result = await runBuild({ in: inDir, out: outDir, skipSdk: true });
      const sdkDir = join(outDir, "min-example", "sdk");
      expect(() => statSync(sdkDir)).toThrow(); // sdk dir absent
      // Other artifacts still present
      const skillPath = join(outDir, "min-example", "SKILL.md");
      expect(statSync(skillPath).isFile()).toBe(true);
      expect(result.artifacts.some((a) => a.path === skillPath)).toBe(true);
      expect(result.artifacts.every((a) => !a.path.includes("/sdk/"))).toBe(true);
    } finally {
      cleanup();
    }
  }, 30000);
});
```

- [ ] **Step 8.2: Run test to verify it fails**

```bash
npx vitest run tests/cli/build-sdk.test.ts 2>&1 | tail -20; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=1`. `runBuild` does not call `renderSdkPackage` and `RunBuildOptions` has no `skipSdk` field.

- [ ] **Step 8.3: Modify `src/cli/build.ts`**

Edit `src/cli/build.ts`:

1. Add import at the top:

```typescript
import { renderSdkPackage } from "../renderers/sdk.js";
```

2. Add `skipSdk` to `RunBuildOptions`:

```typescript
export interface RunBuildOptions {
  readonly in: string;
  readonly out: string;
  readonly productId?: string;
  readonly description?: string;
  readonly skipSdk?: boolean;
}
```

3. In `runBuild`, after the `writeAll` call and before `return`, invoke SDK rendering if not skipped. Replace lines roughly around the `writeAll` invocation:

```typescript
    mkdirSync(opts.out, { recursive: true });
    const artifacts = writeAll(handle.db, opts.out, {
      productId,
      productName,
      description,
      sources: config.sources,
      codegenOverlay,
    });
    if (opts.skipSdk !== true) {
      const oasJson = renderOas(handle.db, {
        productId,
        productName,
        description,
        sources: config.sources,
        codegenOverlay,
      });
      const skillDir = join(opts.out, slug(productName));
      const sdkOutDir = join(skillDir, "sdk");
      const sdkResult = await renderSdkPackage({
        oasJson,
        productName,
        outDir: sdkOutDir,
        overlay: codegenOverlay,
      });
      for (const rel of sdkResult.files) {
        const full = join(sdkOutDir, rel);
        artifacts.push({ path: full, bytes: statSync(full).size });
      }
    }
    return { productId, artifacts, ingest };
```

4. Add the `statSync` import if not present and remove the `readonly` on `artifacts` if the existing typing prevents `push`. Looking at `BuildArtifact[]` it's already mutable.

5. Update the `import { ..., statSync }` line to include `statSync` from `node:fs`.

- [ ] **Step 8.4: Modify `src/cli/index.ts`**

Edit `src/cli/index.ts`. Update the `build` command action to support `--skip-sdk`:

```typescript
  program
    .command("build")
    .description("Ingest sources into the graph and render skill artifacts")
    .option("--in <dir>", "project directory (defaults to cwd)")
    .option("--out <dir>", "output directory (defaults to <in>/skills)")
    .option("--product-id <id>", "override product node id")
    .option("--skip-sdk", "skip SDK package emission (faster builds, no client lib)")
    .action(async (opts: {
      in?: string;
      out?: string;
      productId?: string;
      skipSdk?: boolean;
    }) => {
      const inDir = opts.in ?? process.cwd();
      const outDir = opts.out ?? join(inDir, "skills");
      const result = await runBuild({
        in: inDir,
        out: outDir,
        ...(opts.productId !== undefined ? { productId: opts.productId } : {}),
        ...(opts.skipSdk === true ? { skipSdk: true } : {}),
      });
      printBuildSummary(result.artifacts.map((a) => a.path), outDir);
    });
```

- [ ] **Step 8.5: Run new tests + full suite + typecheck**

```bash
npx vitest run tests/cli/build-sdk.test.ts 2>&1 | tail -20; echo "TEST_EXIT_CODE=$?"
npm test 2>&1 | tail -20; echo "FULL_TEST_EXIT=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=0`, `FULL_TEST_EXIT=0`, `TSC_EXIT_CODE=0`.

- [ ] **Step 8.6: Commit**

```bash
git add src/cli/build.ts src/cli/index.ts tests/cli/build-sdk.test.ts
git commit -m "feat(cli): wire R-SDK into skillship build with --skip-sdk flag

After the existing top-level artifacts land, runBuild invokes
renderSdkPackage with the synthesized OAS doc, the resolved codegen
overlay, and outDir = join(skillDir, 'sdk').

--skip-sdk short-circuits SDK emission (faster CI builds; useful when
only consuming the OpenAPI/MCP artifacts).

Renderer atomic guarantee preserved: tsc failure causes runBuild
to reject and leaves {skillDir}/sdk untouched.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 9: Generate SDK golden trees + lock test

**Spec ref:** §5.5 success criterion 5, §5.7 (Golden lock test).

**Files:**
- Create: `tests/renderers/sdk-golden-helpers.ts`
- Create: `tests/renderers/sdk-golden.test.ts`
- Create: `scripts/gen-sdk-goldens.mts`
- Create: `tests/fixtures/golden/sdk-minimal/` (full tree, committed)
- Create: `tests/fixtures/golden/sdk-minimal/README.md`
- Create: `tests/fixtures/golden/sdk-graphql-minimal/` (full tree, committed)

- [ ] **Step 9.1: Create the shared helpers (no vitest imports)**

Create `tests/renderers/sdk-golden-helpers.ts`:

```typescript
// tests/renderers/sdk-golden-helpers.ts
// Shared helpers used by BOTH:
//   - tests/renderers/sdk-golden.test.ts (lock assertions)
//   - scripts/gen-sdk-goldens.mts (one-off generator)
// No vitest imports; pure Node + project imports only.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraph } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderSyntheticOpenApi } from "../../src/renderers/oas.js";
import { renderSdkPackage } from "../../src/renderers/sdk.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-05-20T12:00:00.000Z";

export interface SdkGoldenResult {
  readonly outDir: string;
}

export async function renderSdkGoldenRest(outDir: string): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({
    fixturePath: "tests/fixtures/openapi3/minimal.yaml",
    contentType: "application/openapi+yaml",
    productId: "p-min",
    productName: "min.example",
    outDir,
  });
}

export async function renderSdkGoldenGraphql(outDir: string): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({
    fixturePath: "tests/fixtures/graphql/minimal.graphql",
    contentType: "application/graphql",
    productId: "p-gql",
    productName: "gql.example",
    outDir,
  });
}

interface FixtureArgs {
  readonly fixturePath: string;
  readonly contentType: string;
  readonly productId: string;
  readonly productName: string;
  readonly outDir: string;
}

async function renderSdkGoldenFromFixture(args: FixtureArgs): Promise<SdkGoldenResult> {
  const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-gld-"));
  const graph = openGraph(join(tmp, "g.db"));
  try {
    const bytes = readFileSync(join(process.cwd(), args.fixturePath));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: args.productName, github_org: null },
      sources: [{ surface: "rest", url: `https://${args.productName}/spec`, sha256: sha, content_type: args.contentType, fetched_at: NOW }],
      coverage: "bronze",
    };
    await ingestConfig({ db: graph.db, config, productId: args.productId, loadBytes: async () => bytes, now: () => NOW });
    const oasJson = renderSyntheticOpenApi({ db: graph.db, productId: args.productId, productName: args.productName, overlay: CodegenOverlaySchema.parse({}) });
    await renderSdkPackage({ oasJson, productName: args.productName, outDir: args.outDir, overlay: CodegenOverlaySchema.parse({}) });
    return { outDir: args.outDir };
  } finally {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
```

- [ ] **Step 9.2: Create the generator script**

Create `scripts/gen-sdk-goldens.mts`:

```typescript
#!/usr/bin/env -S node --import tsx/esm
// One-off generator that writes the two SDK golden trees.
// Run: npx tsx scripts/gen-sdk-goldens.mts
// Output: tests/fixtures/golden/sdk-minimal/ and sdk-graphql-minimal/
// Uses the SAME render code path as the golden lock test.
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  renderSdkGoldenRest,
  renderSdkGoldenGraphql,
} from "../tests/renderers/sdk-golden-helpers.js";

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const restOut = join(repoRoot, "tests/fixtures/golden/sdk-minimal");
  const gqlOut = join(repoRoot, "tests/fixtures/golden/sdk-graphql-minimal");

  rmSync(restOut, { recursive: true, force: true });
  rmSync(gqlOut, { recursive: true, force: true });

  await renderSdkGoldenRest(restOut);
  process.stdout.write(`wrote ${restOut}\n`);

  await renderSdkGoldenGraphql(gqlOut);
  process.stdout.write(`wrote ${gqlOut}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`gen-sdk-goldens: ${msg}\n`);
  process.exit(1);
});
```

- [ ] **Step 9.3: Run the generator**

```bash
cd /Users/riteshkewlani/github/skillship
npx tsx scripts/gen-sdk-goldens.mts 2>&1; echo "GEN_EXIT_CODE=$?"
```

Expected: `GEN_EXIT_CODE=0`. Both golden trees written. If this fails, the renderer or plugins have a bug; root-cause it (autonomous Rule 2 — no cascade failures).

- [ ] **Step 9.4: Review the golden tree size and content**

```bash
find tests/fixtures/golden/sdk-minimal -type f | wc -l
find tests/fixtures/golden/sdk-graphql-minimal -type f | wc -l
ls tests/fixtures/golden/sdk-minimal/
ls tests/fixtures/golden/sdk-minimal/src/ 2>/dev/null
```

Expected: each tree has 5 top-level files (`package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `.npmignore`) plus a `src/` directory with the emitted code. Spot-check `src/errors.ts`, `src/runtime.ts`, `src/resources.ts` exist with the expected exports.

- [ ] **Step 9.5: Create the golden review README**

Create `tests/fixtures/golden/sdk-minimal/README.md`:

```markdown
# SDK Golden Tree — REST fixture

This directory is a byte-identical lock of the R-SDK emit for
`tests/fixtures/openapi3/minimal.yaml`. Any change here means the SDK
emitter behavior changed.

## How to regenerate

```sh
npx tsx scripts/gen-sdk-goldens.mts
```

This overwrites both `sdk-minimal/` and `sdk-graphql-minimal/` from
the same render code path as `tests/renderers/sdk-golden.test.ts`.

## How to review a diff

When you regenerate and see a diff, sort the changes into three buckets:

1. **`src/*.ts` changes** — behavior changes. Read the test expectations
   in `tests/sdk-plugins/*.test.ts` first; if the diff matches an
   intentional plugin change, accept. If not, the plugin or renderer
   needs a fix.
2. **`package.json`, `tsconfig.json`, `README.md`, `LICENSE`, `.npmignore`**
   — template changes. Confirm `src/renderers/sdk-templates/render.ts`
   substitution semantics didn't drift unexpectedly.
3. **Whitespace / formatting** — Prettier version bump or config change.
   Verify against `package.json` deps. Whitespace-only diffs should
   correlate with a Prettier upgrade commit; otherwise investigate.

Per spec §5.9 R2-4: do not "rubber-stamp" large diffs. Bisect by
plugin if the diff is large and unexpected.
```

(No equivalent README for the GraphQL tree — one README documents the process for both.)

- [ ] **Step 9.6: Create the golden lock test**

Create `tests/renderers/sdk-golden.test.ts`:

```typescript
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { renderSdkGoldenRest, renderSdkGoldenGraphql } from "./sdk-golden-helpers.js";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const sub of listFilesRecursive(full)) out.push(join(name, sub));
    } else {
      out.push(name);
    }
  }
  return out;
}

function compareTrees(actualDir: string, goldenDir: string): void {
  const actual = listFilesRecursive(actualDir).sort();
  const golden = listFilesRecursive(goldenDir).sort();
  expect(actual, "file lists differ").toEqual(golden);
  for (const rel of actual) {
    const a = readFileSync(join(actualDir, rel), "utf8");
    const g = readFileSync(join(goldenDir, rel), "utf8");
    expect(a, `byte-identity mismatch in ${rel}`).toBe(g);
  }
}

describe("SDK golden lock", () => {
  test("REST golden tree is byte-identical to tests/fixtures/golden/sdk-minimal/", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-gld-rest-"));
    const out = join(tmp, "sdk");
    try {
      await renderSdkGoldenRest(out);
      compareTrees(out, join(process.cwd(), "tests/fixtures/golden/sdk-minimal"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60000);

  test("GraphQL golden tree is byte-identical to tests/fixtures/golden/sdk-graphql-minimal/", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-gld-gql-"));
    const out = join(tmp, "sdk");
    try {
      await renderSdkGoldenGraphql(out);
      compareTrees(out, join(process.cwd(), "tests/fixtures/golden/sdk-graphql-minimal"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60000);

  test("REST golden tsconfig.json typechecks against its own sources", () => {
    const goldenDir = join(process.cwd(), "tests/fixtures/golden/sdk-minimal");
    const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
    try {
      execFileSync(tscBin, ["--noEmit", "-p", goldenDir], { stdio: "pipe" });
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`golden tsc failed:\nstdout:\n${e.stdout?.toString() ?? ""}\nstderr:\n${e.stderr?.toString() ?? ""}`);
    }
  }, 30000);

  test("GraphQL golden tsconfig.json typechecks against its own sources", () => {
    const goldenDir = join(process.cwd(), "tests/fixtures/golden/sdk-graphql-minimal");
    const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
    try {
      execFileSync(tscBin, ["--noEmit", "-p", goldenDir], { stdio: "pipe" });
    } catch (err: unknown) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`golden tsc failed:\nstdout:\n${e.stdout?.toString() ?? ""}\nstderr:\n${e.stderr?.toString() ?? ""}`);
    }
  }, 30000);
});
```

- [ ] **Step 9.7: Run the golden lock test**

```bash
npx vitest run tests/renderers/sdk-golden.test.ts 2>&1 | tail -20; echo "TEST_EXIT_CODE=$?"
```

Expected: `TEST_EXIT_CODE=0`. 4 tests pass (REST byte-identity, GraphQL byte-identity, REST tsc, GraphQL tsc).

- [ ] **Step 9.8: Run the full suite + typecheck**

```bash
npm test 2>&1 | tail -20; echo "FULL_TEST_EXIT=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
```

Expected: `FULL_TEST_EXIT=0`, `TSC_EXIT_CODE=0`. All suites green.

- [ ] **Step 9.9: Commit**

The golden trees may be large (potentially dozens of files). Commit them as data:

```bash
git add tests/renderers/sdk-golden-helpers.ts \
        tests/renderers/sdk-golden.test.ts \
        tests/fixtures/golden/sdk-minimal/ \
        tests/fixtures/golden/sdk-graphql-minimal/ \
        scripts/gen-sdk-goldens.mts
git commit -m "test(sdk): SDK golden trees + lock test + tsc gate

Two committed golden trees from tests/fixtures/{openapi3,graphql}/minimal:
- sdk-minimal/ (REST source)
- sdk-graphql-minimal/ (GraphQL source)

Lock test asserts byte-identity (file list + content per file). Plus
tsc --noEmit gate against each golden's tsconfig — the strict-mode
typecheck IS the conformance bar (spec §2 locked decision).

Golden review process documented at sdk-minimal/README.md (per
spec §5.9 R2-4 mitigation).

Generator script (scripts/gen-sdk-goldens.mts) reuses the lock test's
shared helpers (sdk-golden-helpers.ts) so the regen code path is
byte-identical to the verification code path.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 10: Plan 2 final preflight + tag `r-sdk-wedge/frozen`

- [ ] **Step 10.1: Run full preflight (the gate)**

```bash
cd /Users/riteshkewlani/github/skillship
npm test 2>&1 | tail -20; echo "TEST_EXIT_CODE=$?"
npm run typecheck 2>&1 | tail -10; echo "TSC_EXIT_CODE=$?"
npm run build 2>&1 | tail -10; echo "BUILD_EXIT_CODE=$?"
```

Expected: all three exit 0. If any fail, STOP and fix before tagging (no broken tags).

- [ ] **Step 10.2: Verify Plan 2 acceptance criteria**

Manually verify the 8 success criteria from spec §5.5:

1. `tests/fixtures/golden/sdk-minimal/package.json` parses as valid JSON with `type: "module"` and `exports`.
2. `tests/renderers/sdk-golden.test.ts`'s tsc-gate tests pass.
3. `tests/sdk-plugins/resource-tree.test.ts` has tests for nested resource shaping.
4. `tests/sdk-plugins/errors.test.ts` asserts the 7 classes.
5. Both golden trees + lock test pass (run in 10.1).
6. All plugin unit tests pass.
7. Determinism test in `tests/renderers/sdk.test.ts` passes.
8. `tests/cli/build-sdk.test.ts` verifies `--skip-sdk` short-circuits.

Document any criterion that did NOT land in a commit message — but the plan does not let you tag until all 8 are green (autonomous Rule 6, no invisible failures).

- [ ] **Step 10.3: Confirm `substrate/frozen` still points where Plan 1.5 left it**

```bash
git log substrate/frozen --format='%H %s' -1
```

Expected: still at the Plan 1.5 final commit, NOT at HEAD. Plan 2 work happens between `substrate/frozen` and the new `r-sdk-wedge/frozen` tag.

- [ ] **Step 10.4: Tag `r-sdk-wedge/frozen`**

```bash
git tag r-sdk-wedge/frozen HEAD
git log -1 r-sdk-wedge/frozen --format='%H %s'
```

Expected: tag placed at HEAD with a meaningful commit subject. **Do not push** (local-only per user's no-remote-push policy until explicitly authorized).

- [ ] **Step 10.5: Final summary**

```bash
echo "=== Plan 2 final state ==="
git log substrate/frozen..r-sdk-wedge/frozen --oneline | wc -l
git log substrate/frozen..r-sdk-wedge/frozen --oneline
```

Expected: ~10 commits between the two tags (one per task). Each commit subject is meaningful.

---

## Plan 2 Acceptance

When Tasks 1–10 are complete, the following must hold:

1. `npm test`, `npm run typecheck`, `npm run build` all exit 0.
2. Plugin unit tests (`tests/sdk-plugins/*.test.ts`) all green.
3. Renderer determinism + atomic-guarantee tests in `tests/renderers/sdk.test.ts` green.
4. Both SDK golden trees (`tests/fixtures/golden/sdk-{minimal,graphql-minimal}/`) match a fresh render byte-for-byte.
5. Both golden trees pass `tsc --noEmit` against their own `tsconfig.json`.
6. `runBuild` emits `{outDir}/{product-slug}/sdk/` by default; `--skip-sdk` short-circuits without affecting other artifacts.
7. `r-sdk-wedge/frozen` tag at HEAD; `substrate/frozen` unchanged from Plan 1.5.
8. Deps: `@hey-api/openapi-ts` and `prettier` both exact-pinned, both MIT.
9. Repo license remains MIT; no restrictive-license transitive deps (verify via `npm ls --omit=dev | head -20`).

---

## Risk Log (Plan 2)

| Risk | Mitigation |
|---|---|
| R2-1 — Hey API plugin API drift | Exact pin (no caret); Task 1.5 reads the dist .d.ts of the installed version; the comment in `src/renderers/sdk.ts` records the pinned version; review the API again on every dep bump. |
| R2-2 — Quality ceiling bounded by Hey API's emitter | Task 7 builds room for module-specific hand-written replacement (the renderer just hands template strings to the engine; replacing one plugin with hand-written emit doesn't touch the others). Operational trigger: a focused implementation session of plugin-tuning fails to produce a green golden + tsc-pass for a module → switch to hand-written for that module. Bounded scope by construction. |
| R2-3 — Build hot-path cost (SDK gen adds seconds) | `--skip-sdk` flag in Task 8. Future Plan 2c could add incremental-render-on-graph-delta. |
| R2-4 — Golden churn (hundreds of files in diffs) | Task 9 includes `sdk-minimal/README.md` documenting the diff review process (3 buckets: src/, templates, formatting). Reviewers do NOT rubber-stamp. |
| R2-5 — Hey API plugin contract uncertainty during Task 4-6 implementation | Plugin pure functions (`generateErrorsModule`, `generateRuntimeModule`, `buildNamespaceTree`) are unit-tested independently of the Hey API engine. The factory wrappers (`errorsPlugin`, `runtimePlugin`, `resourceTreePlugin`) are the only Hey-API-coupled code; if the plugin shape differs at the pinned version, those factories are the small surface area to adjust. |

---

## Out of Scope for Plan 2

- pagination, retries, streaming, webhooks plugins (Plan 2b)
- msw runtime conformance suite (Plan 2b)
- Python or other-language SDKs
- R-MCP wiring (Plan 3)
- Hand-written emitter fallback (only invoked if R2-2 trigger fires; not pre-built)
- Incremental render-on-graph-delta
- GitHub-release-automation (Plan 4)
- Hosted control plane (Plan 6)

---

## Plan Size Sanity Check

Source LOC (excluding emitted golden data):
- `src/renderers/sdk.ts`: ~180 lines (split into 10+ helpers, each <50 lines)
- `src/sdk-plugins/errors.ts`: ~80 lines
- `src/sdk-plugins/runtime.ts`: ~110 lines
- `src/sdk-plugins/resource-tree.ts`: ~70 lines
- `src/renderers/sdk-templates/render.ts`: ~50 lines
- Templates (5 × .tpl files): ~80 lines total (data, not code)
- `src/cli/build.ts` diff: +30 lines
- `src/cli/index.ts` diff: +5 lines

Test LOC:
- `tests/sdk-plugins/errors.test.ts`: ~50 lines
- `tests/sdk-plugins/runtime.test.ts`: ~60 lines
- `tests/sdk-plugins/resource-tree.test.ts`: ~70 lines
- `tests/renderers/sdk.test.ts`: ~150 lines
- `tests/renderers/sdk-templates.test.ts`: ~60 lines
- `tests/renderers/sdk-golden.test.ts`: ~80 lines
- `tests/renderers/sdk-golden-helpers.ts`: ~70 lines
- `tests/cli/build-sdk.test.ts`: ~80 lines
- `scripts/gen-sdk-goldens.mts`: ~30 lines

Total source + test LOC: ~1100 lines. Reasonable for a 3-plugin + orchestrator + golden lock effort.

Golden tree size (data): potentially 20-50 generated files per tree, totaling perhaps 50KB-200KB of committed text. Reviewed per the bucket process in `tests/fixtures/golden/sdk-minimal/README.md`.
