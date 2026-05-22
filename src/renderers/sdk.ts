// src/renderers/sdk.ts
// pinned: @hey-api/openapi-ts@0.97.2 — see KNOWN_GAPS.md if upgrading
// Emits a TypeScript SDK npm package from a synthetic OpenAPI doc.
// Pipeline:
//   1. temp-write OAS doc
//   2. run Hey API codegen with ["@hey-api/typescript", "@hey-api/sdk"] only
//      (the 3 wedge plugins return { name, output, handler } which is NOT a
//       valid Hey API 0.97.2 plugin shape — see DefinePlugin in @hey-api/shared.
//       Manual emission is the documented Plan 2 R2-1 fallback.)
//   3. delete openapi.json from tempDir so it does not ship in the package
//   4. emit errors.ts, runtime.ts, resources.ts manually into src/
//   5. write package templates (package.json, tsconfig.json, README, LICENSE, .npmignore)
//   6. format emitted TS with Prettier
//   7. run tsc --noEmit against the temp package
//   8. on exit 0, atomic-rename temp → input.outDir
// On ANY failure the final outDir is left untouched (atomic guarantee).
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
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
import { generateErrorsModule } from "../sdk-plugins/errors.js";
import { generateEntryModule } from "../sdk-plugins/entry.js";
import {
  generateRuntimeModule,
  type AuthSchemeDescriptor,
} from "../sdk-plugins/runtime.js";
import {
  buildNamespaceTree,
  generateResourceTreeModule,
  type OperationInfo,
} from "../sdk-plugins/resource-tree.js";
import { renderTemplates } from "./sdk-templates/render.js";
import { extractAuthSchemes, extractOperations } from "./sdk-utils.js";

const execFileP = promisify(execFile);

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
  const tempDir = mkdtempSync(join(tmpdir(), "sk-sdk-"));
  try {
    const oasPath = writeOasToTemp(input.oasJson, tempDir);
    const schemes = extractAuthSchemes(input.oasJson);
    const ops = extractOperations(input.oasJson);
    await runHeyApiCodegen(oasPath, tempDir);
    // Remove openapi.json immediately after codegen — Hey API has finished
    // reading it. Without this, the file ships in the npm package and leaks
    // customer paths and security-scheme metadata (Critical 1 fix).
    rmSync(oasPath);
    writeWedgeModules(tempDir, schemes, ops, input.overlay);
    writePackageTemplates(tempDir, input);
    await formatWithPrettier(tempDir);
    const { exitCode, stdout, stderr } = await runTypecheckGate(tempDir);
    if (exitCode !== 0) {
      throw new Error(
        `renderSdkPackage: tsc --noEmit exited ${exitCode}\n${stderr}\n${stdout}`,
      );
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

// ---- Hey API codegen ----
// Uses only ["@hey-api/typescript", "@hey-api/sdk"] — the wedge plugins
// (errors, runtime, resource-tree) are emitted manually below.
// Verified at @hey-api/openapi-ts@0.97.2: UserConfig.plugins only accepts
// PluginNames from the registered PluginConfigMap; custom { name, output, handler }
// objects are not accepted by the type system (DefinePlugin shape mismatch).
async function runHeyApiCodegen(
  oasPath: string,
  tempDir: string,
): Promise<void> {
  const { createClient } = await import("@hey-api/openapi-ts");
  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  // postProcess:[] avoids the deprecated format:false flag (Critical 3 fix).
  // The cast is needed because Hey API 0.97.2 does not export its config type
  // cleanly; the return type mismatch is benign (we only await completion).
  await (createClient as unknown as (cfg: {
    input: string;
    output: { path: string; postProcess: string[] };
    logs: { level: string };
    plugins: string[];
  }) => Promise<void>)({
    input: oasPath,
    output: { path: srcDir, postProcess: [] },
    logs: { level: "silent" },
    plugins: ["@hey-api/typescript", "@hey-api/sdk"],
  });
}

// ---- Manual wedge module emission ----

function writeWedgeModules(
  tempDir: string,
  schemes: readonly AuthSchemeDescriptor[],
  ops: readonly OperationInfo[],
  overlay: CodegenOverlay,
): void {
  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeWedgeFile(srcDir, "errors.ts", generateErrorsModule());
  writeWedgeFile(srcDir, "runtime.ts", generateRuntimeModule(schemes));
  const tree = buildNamespaceTree(ops, overlay);
  writeWedgeFile(
    srcDir,
    "resources.ts",
    generateResourceTreeModule(tree, ops, overlay),
  );
  // Intentionally overwrite Hey API's generated index.ts with the wedge barrel so
  // the package entry point exposes Client/attachResources/errors — not the raw flat ops.
  writeFileSync(join(srcDir, "index.ts"), generateEntryModule(), "utf8");
}

function writeWedgeFile(srcDir: string, name: string, content: string): void {
  const target = join(srcDir, name);
  if (existsSync(target)) {
    throw new Error(
      `renderSdkPackage: wedge module collision at ${target}; Hey API output already wrote a file here`,
    );
  }
  writeFileSync(target, content, "utf8");
}

// ---- Package template emission ----

function writePackageTemplates(tempDir: string, input: RenderSdkInput): void {
  const slug = slugify(input.productName);
  if (!slug) {
    throw new Error(
      `renderSdkPackage: productName '${input.productName}' slugifies to empty`,
    );
  }
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

// ---- Prettier formatting ----

async function formatWithPrettier(tempDir: string): Promise<void> {
  // Format ALL .ts including Hey API .gen.ts. This normalizes whitespace
  // drift across Hey API minor versions, keeping the determinism contract
  // stable; semantic drift (renamed symbols, import order) is NOT normalized
  // and is caught at the byte-determinism test or tsc gate.
  const prettierMod = await import("prettier");
  const { format } = prettierMod;
  for (const file of walkTs(tempDir)) {
    const src = readFileSync(file, "utf8");
    const formatted = await format(src, {
      parser: "typescript",
      semi: true,
      singleQuote: false,
    });
    writeFileSync(file, formatted, "utf8");
  }
}

function* walkTs(dir: string): IterableIterator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) yield full;
  }
}

// ---- tsc gate ----

interface TypecheckResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runTypecheckGate(tempDir: string): Promise<TypecheckResult> {
  const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
  try {
    await execFileP(tscBin, ["--noEmit", "-p", tempDir]);
    return { exitCode: 0, stdout: "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

// ---- Atomic rename (cross-filesystem-safe) ----

function atomicMove(tempDir: string, outDir: string): void {
  mkdirSync(dirname(outDir), { recursive: true });
  if (statSyncSafe(outDir)) rmSync(outDir, { recursive: true, force: true });
  crossFsRename(tempDir, outDir);
}

/**
 * Renames src → dst atomically where possible.
 * Falls back to cpSync + rmSync when renameSync throws EXDEV (cross-device
 * move — common in CI containers where /tmp is tmpfs and outDir is on the
 * host filesystem). If cpSync itself fails, dst is removed before re-throwing
 * to preserve the "dst absent on failure" invariant.
 */
function crossFsRename(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code !== "EXDEV") throw err;
    try {
      cpSync(src, dst, { recursive: true });
    } catch (copyErr) {
      rmSync(dst, { recursive: true, force: true });
      throw copyErr;
    }
    rmSync(src, { recursive: true, force: true });
  }
}

function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") return false;
    throw err;
  }
}

// ---- File listing ----

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

// ---- Utilities ----

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
