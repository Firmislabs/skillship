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
