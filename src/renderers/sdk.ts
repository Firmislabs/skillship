// src/renderers/sdk.ts
// pinned: @hey-api/openapi-ts@0.97.2 — see KNOWN_GAPS.md if upgrading
// Emits a TypeScript SDK npm package from a synthetic OpenAPI doc.
// Pipeline:
//   1. temp-write OAS doc
//   2. run Hey API codegen with ["@hey-api/typescript", "@hey-api/sdk"] only
//      (the 3 wedge plugins return { name, output, handler } which is NOT a
//       valid Hey API 0.97.2 plugin shape — see DefinePlugin in @hey-api/shared.
//       Manual emission is the documented Plan 2 R2-1 fallback.)
//   3. emit errors.ts, runtime.ts, resources.ts manually into src/
//   4. write package templates (package.json, tsconfig.json, README, LICENSE, .npmignore)
//   5. format emitted TS with Prettier
//   6. run tsc --noEmit against the temp package
//   7. on exit 0, atomic-rename temp → input.outDir
// On ANY failure the final outDir is left untouched (atomic guarantee).
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
import { generateErrorsModule } from "../sdk-plugins/errors.js";
import {
  generateRuntimeModule,
  type AuthSchemeDescriptor,
} from "../sdk-plugins/runtime.js";
import {
  buildNamespaceTree,
  generateResourceTreeModule,
} from "../sdk-plugins/resource-tree.js";
import { renderTemplates } from "./sdk-templates/render.js";

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
    writeWedgeModules(tempDir, schemes, ops, input.overlay);
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

// ---- OAS extraction helpers ----

interface OasSecurityScheme {
  readonly type?: string;
  readonly scheme?: string;
  readonly in?: string;
  readonly name?: string;
}
interface OasComponents {
  readonly securitySchemes?: Record<string, OasSecurityScheme>;
}
interface OasOperation {
  readonly operationId?: string;
  readonly tags?: readonly string[];
}
type OasPathItem = Record<string, OasOperation>;
interface OasDoc {
  readonly components?: OasComponents;
  readonly paths?: Record<string, OasPathItem>;
}

function extractAuthSchemes(oasJson: string): readonly AuthSchemeDescriptor[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const schemes = doc.components?.securitySchemes ?? {};
  const out: AuthSchemeDescriptor[] = [];
  for (const id of Object.keys(schemes).sort()) {
    const s = schemes[id]!;
    if (s.type === "http" && s.scheme === "bearer") {
      out.push({ kind: "bearer", id });
    } else if (s.type === "http" && s.scheme === "basic") {
      out.push({ kind: "basic", id });
    } else if (s.type === "apiKey") {
      const loc: "header" | "query" = s.in === "query" ? "query" : "header";
      const name = typeof s.name === "string" ? s.name : "Authorization";
      out.push({ kind: "apiKey", id, in: loc, name });
    }
  }
  return out;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"] as const;

function extractOperations(oasJson: string): readonly OperationEntry[] {
  const doc = JSON.parse(oasJson) as OasDoc;
  const paths = doc.paths ?? {};
  const out: OperationEntry[] = [];
  for (const pathKey of Object.keys(paths).sort()) {
    const item = paths[pathKey]!;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== "object") continue;
      if (!op.operationId) continue;
      out.push({
        operationId: op.operationId,
        tags: Array.isArray(op.tags) ? [...op.tags] : [],
      });
    }
  }
  return out;
}

interface OperationEntry {
  readonly operationId: string;
  readonly tags: readonly string[];
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
  await createClient({
    input: oasPath,
    output: { path: srcDir, format: false },
    logs: { level: "silent" },
    plugins: ["@hey-api/typescript", "@hey-api/sdk"],
  } as unknown as Parameters<typeof createClient>[0]);
}

// ---- Manual wedge module emission ----

function writeWedgeModules(
  tempDir: string,
  schemes: readonly AuthSchemeDescriptor[],
  ops: readonly OperationEntry[],
  overlay: CodegenOverlay,
): void {
  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "errors.ts"), generateErrorsModule(), "utf8");
  writeFileSync(join(srcDir, "runtime.ts"), generateRuntimeModule(schemes), "utf8");
  const tree = buildNamespaceTree(ops, overlay);
  writeFileSync(
    join(srcDir, "resources.ts"),
    generateResourceTreeModule(tree, "./sdk.gen.js"),
    "utf8",
  );
}

// ---- Package template emission ----

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

// ---- Prettier formatting ----

async function formatWithPrettier(tempDir: string): Promise<void> {
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

async function runTypecheckGate(tempDir: string): Promise<number> {
  const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
  try {
    await execFileP(tscBin, ["--noEmit", "-p", tempDir]);
    return 0;
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    process.stderr.write(
      `renderSdkPackage tsc stdout:\n${e.stdout ?? ""}\nstderr:\n${e.stderr ?? ""}\n`,
    );
    return typeof e.code === "number" ? e.code : 1;
  }
}

// ---- Atomic rename ----

function atomicMove(tempDir: string, outDir: string): void {
  mkdirSync(dirname(outDir), { recursive: true });
  if (statSyncSafe(outDir)) rmSync(outDir, { recursive: true, force: true });
  renameSync(tempDir, outDir);
}

function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
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
