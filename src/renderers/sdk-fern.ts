// src/renderers/sdk-fern.ts
// Orchestrates the opt-in Python/Rust path. Called AFTER renderSdkPackage; the
// TS path is untouched. Loops per language so one generator failing does not
// block another (failed languages are aggregated; successful sibling dirs and
// the TS sdk/ persist).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodegenOverlay } from "../overlays/codegen.js";
import { extractOperations, extractAuthSchemes } from "./sdk-utils.js";
import { detectPagination } from "./pagination-detect.js";
import { buildFernOas } from "./fern-oas-rewrite.js";
import { buildFernProject, type FernOAuthPlan } from "./fern-project.js";
import { assertDockerAvailable, runFernGenerate } from "./fern-docker.js";
import { atomicMove, statSyncSafe } from "./sdk-fs.js";
import type { FernLang } from "./fern-images.js";
import type { AuthSchemeDescriptor } from "../sdk-plugins/runtime.js";

export type { FernLang } from "./fern-images.js";
export type { FernOAuthPlan } from "./fern-project.js";

export interface RenderFernSdksInput {
  readonly oasJson: string;
  /**
   * Product name. Accepted for symmetry with renderSdkPackage and surfaced in
   * failure diagnostics. NOTE: the Python package name is intentionally FIXED
   * ("skillship_sdk", per Spike 0.3) for deterministic output — productName does
   * NOT drive it.
   */
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
  const plans = detectPagination(ops, input.oasJson, input.overlay);
  const schemes = extractAuthSchemes(input.oasJson, input.overlay);
  const oauth = computeFernOAuthPlan(schemes, input.oasJson);
  const fernOas = buildFernOas(input.oasJson, ops, input.overlay, plans);

  const emitted: { lang: FernLang; path: string }[] = [];
  const failures: string[] = [];
  for (const lang of input.langs) {
    try {
      const path = await renderOneLang(lang, fernOas, input.outDir, oauth);
      emitted.push({ lang, path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${lang}: ${msg}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `renderFernSdks(${input.productName}): ${failures.length} generator(s) failed ` +
        `(${failures.join("; ")}). Successful languages and the TypeScript SDK were written.`,
    );
  }
  return { emitted };
}

/**
 * Computes a FernOAuthPlan from the OAS security schemes and the synthetic OAS.
 * Returns null unless ALL of the following hold:
 *  1. An oauth2ClientCredentials descriptor exists with non-null tokenUrl.
 *  2. The tokenUrl's path matches an OAS path that has a POST operation
 *     (path-presence gate ONLY — no host comparison since synthetic OAS has no
 *     servers block).
 *  3. The token op's 200 response schema has at least an access_token property.
 *  4. The token op's requestBody schema has at least one named property.
 *     (If absent, the plan is null — Fern's request-properties cannot be empty.)
 */
export function computeFernOAuthPlan(
  schemes: readonly AuthSchemeDescriptor[],
  oasJson: string,
): FernOAuthPlan | null {
  const descriptor = findOAuth2Descriptor(schemes);
  if (descriptor === null) return null;

  // descriptor.tokenUrl is non-null (findOAuth2Descriptor gate), but TypeScript
  // cannot narrow through the function boundary — assert the type here.
  const tokenUrl = descriptor.tokenUrl as string;
  const tokenPath = extractPath(tokenUrl);
  if (tokenPath === null) return null;

  const doc = JSON.parse(oasJson) as OasDoc;
  const tokenOp = findPostOperation(doc, tokenPath);
  if (tokenOp === null) return null;

  const requestProps = extractRequestBodyProps(tokenOp);
  if (requestProps === null) return null;

  const responseProps = extractResponseProps(tokenOp);
  if (responseProps === null) return null;

  return {
    tokenEndpoint: `POST ${tokenPath}`,
    requestProps,
    responseProps,
  };
}

// ---- Internal helpers ----

interface OasSchema {
  readonly type?: string;
  readonly properties?: Record<string, unknown>;
}

interface OasRequestBody {
  readonly content?: Record<string, { readonly schema?: OasSchema }>;
}

interface OasResponse {
  readonly content?: Record<string, { readonly schema?: OasSchema }>;
}

interface OasOperation {
  readonly requestBody?: OasRequestBody;
  readonly responses?: Record<string, OasResponse>;
}

type OasPathItem = Record<string, OasOperation>;

interface OasDoc {
  readonly paths?: Record<string, OasPathItem>;
}

function findOAuth2Descriptor(
  schemes: readonly AuthSchemeDescriptor[],
): Extract<AuthSchemeDescriptor, { kind: "oauth2ClientCredentials" }> | null {
  for (const s of schemes) {
    if (s.kind === "oauth2ClientCredentials" && s.tokenUrl !== null) {
      return s;
    }
  }
  return null;
}

/** Extracts just the path component from a URL, e.g. "https://host/oauth/token" → "/oauth/token". */
function extractPath(tokenUrl: string): string | null {
  try {
    const url = new URL(tokenUrl);
    return url.pathname || null;
  } catch {
    // If URL parse fails, treat as a path already
    if (tokenUrl.startsWith("/")) return tokenUrl;
    return null;
  }
}

function findPostOperation(doc: OasDoc, path: string): OasOperation | null {
  const item = doc.paths?.[path];
  if (!item) return null;
  const op = item["post"];
  if (!op || typeof op !== "object") return null;
  return op;
}

/**
 * Extracts request body properties from the token op and maps them to
 * Fern request-properties format: { "kebab-key": "$request.field_name" }.
 * Returns null if no requestBody or no named properties exist.
 */
function extractRequestBodyProps(
  op: OasOperation,
): Readonly<Record<string, string>> | null {
  if (!op.requestBody?.content) return null;
  for (const mediaType of Object.values(op.requestBody.content)) {
    const schema = mediaType?.schema;
    if (!schema?.properties) continue;
    const props = schema.properties;
    const keys = Object.keys(props);
    if (keys.length === 0) continue;
    const result: Record<string, string> = {};
    for (const key of keys) {
      result[toKebab(key)] = `$request.${key}`;
    }
    return result;
  }
  return null;
}

/**
 * Extracts 200 response properties from the token op and maps them to
 * Fern response-properties format: { "kebab-key": "$response.field_name" }.
 * Returns null if no 200 response or no access_token property exists.
 */
function extractResponseProps(
  op: OasOperation,
): Readonly<Record<string, string>> | null {
  const resp = op.responses?.["200"];
  if (!resp?.content) return null;
  for (const mediaType of Object.values(resp.content)) {
    const schema = mediaType?.schema;
    if (!schema?.properties) continue;
    const props = schema.properties;
    if (!("access_token" in props)) continue;
    const result: Record<string, string> = {};
    for (const key of Object.keys(props)) {
      result[toKebab(key)] = `$response.${key}`;
    }
    return result;
  }
  return null;
}

/** Converts underscore_names to kebab-names for Fern property keys. */
function toKebab(name: string): string {
  return name.replace(/_/g, "-");
}

async function renderOneLang(
  lang: FernLang,
  fernOas: string,
  outDir: string,
  oauth: FernOAuthPlan | null,
): Promise<string> {
  const projectDir = mkdtempSync(join(tmpdir(), `sk-fern-${lang}-`));
  try {
    const { files } = buildFernProject([lang], { oauth });
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
      throw new Error(`Fern produced no output for ${lang} (expected at ${generated})`);
    }
    const dest = join(outDir, `sdk-${lang}`);
    atomicMove(generated, dest);
    return dest;
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
}
