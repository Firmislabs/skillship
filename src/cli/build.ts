import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Database as Sqlite3Database } from "better-sqlite3";
import { openGraph } from "../graph/db.js";
import { ingestConfig, type IngestSummary } from "../ingest/pipeline.js";
import { renderSkillMd } from "../renderers/skill.js";
import { renderOpReference } from "../renderers/opReference.js";
import { renderMcpJson } from "../renderers/mcpJson.js";
import {
  renderLlmsTxt,
  renderLlmsFullTxt,
} from "../renderers/llmsTxt.js";
import type {
  ConfigSourceEntry,
  SkillshipConfig,
} from "../discovery/config.js";
import { GITHUB_REPO_PLACEHOLDER } from "../resolvers/githubSpecs.js";
import { renderSyntheticOpenApi } from "../renderers/oas.js";
import { loadCodegenOverlay, type CodegenOverlay } from "../overlays/codegen.js";
import { renderSdkPackage } from "../renderers/sdk.js";
import { renderFernSdks } from "../renderers/sdk-fern.js";
import { listEmittedFiles } from "../renderers/sdk-fs.js";
import type { FernLang } from "../renderers/fern-images.js";

export interface RunBuildOptions {
  readonly in: string;
  readonly out: string;
  readonly productId?: string;
  readonly description?: string;
  readonly skipSdk?: boolean;
  readonly fernLangs?: readonly FernLang[];
}

export interface BuildArtifact {
  readonly path: string;
  readonly bytes: number;
}

export interface BuildResult {
  readonly productId: string;
  readonly artifacts: BuildArtifact[];
  readonly ingest: IngestSummary;
}

export async function runBuild(opts: RunBuildOptions): Promise<BuildResult> {
  const skDir = join(opts.in, ".skillship");
  const configPath = join(skDir, "config.yaml");
  if (!existsSync(configPath)) {
    throw new Error(`runBuild: missing ${configPath}`);
  }
  const config = parseYaml(readFileSync(configPath, "utf8")) as SkillshipConfig;
  const codegenOverlay = loadCodegenOverlay(opts.in);
  const dbPath = join(skDir, "graph.sqlite");
  const sourcesDir = join(skDir, "sources");
  const productId =
    opts.productId ?? derivedProductId(config.product.domain);
  const productName = displayName(config.product.domain);
  const description = opts.description ?? defaultDescription(productName);

  const handle = openGraph(dbPath);
  try {
    const ingest = await ingestConfig({
      db: handle.db,
      config,
      productId,
      loadBytes: bytesLoaderFrom(sourcesDir),
    });
    if (ingest.operations === 0 && hasApiSurfaceSource(config.sources)) {
      process.stderr.write(
        "skillship build: an API-surface source (rest/grpc) produced 0 " +
          "operations. This usually means a content_type mismatch or an " +
          "unsupported surface, so no extractor ran. The emitted SDK will " +
          "have no operations.\n",
      );
    }
    mkdirSync(opts.out, { recursive: true });
    const { artifacts, oasJson, skillDir } = writeAll(handle.db, opts.out, {
      productId,
      productName,
      description,
      sources: config.sources,
      codegenOverlay,
    });
    // Whole-build atomicity is NOT guaranteed: the top-level artifacts above
    // are already on disk. If SDK rendering throws, those persist by design
    // (the SDK subtree itself is atomic — see renderSdkPackage).
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
  } finally {
    handle.close();
  }
}

function hasApiSurfaceSource(
  sources: readonly ConfigSourceEntry[],
): boolean {
  return sources.some(
    (s) =>
      (s.surface === "rest" || s.surface === "grpc") &&
      s.content_type !== GITHUB_REPO_PLACEHOLDER,
  );
}

interface WriteArgs {
  readonly productId: string;
  readonly productName: string;
  readonly description: string;
  readonly sources: readonly ConfigSourceEntry[];
  readonly codegenOverlay: CodegenOverlay;
}

interface WriteAllResult {
  readonly artifacts: BuildArtifact[];
  readonly oasJson: string;
  readonly skillDir: string;
}

function writeAll(
  db: Sqlite3Database,
  outDir: string,
  args: WriteArgs,
): WriteAllResult {
  const skillDir = join(outDir, slug(args.productName));
  mkdirSync(skillDir, { recursive: true });
  const oasJson = renderOas(db, args);
  const topLevel: [string, string][] = [
    [join(skillDir, "SKILL.md"), renderSkill(db, args)],
    [join(skillDir, ".mcp.json"), renderMcp(db, args)],
    [join(skillDir, "openapi.json"), oasJson],
    [join(skillDir, "llms.txt"), renderShortLlms(db, args)],
    [join(skillDir, "llms-full.txt"), renderFullLlms(db, args)],
    [join(skillDir, "manifest.json"), renderManifest(args)],
  ];
  const topArtifacts = topLevel.map(([path, content]) => {
    writeFileSync(path, content, "utf8");
    return { path, bytes: Buffer.byteLength(content, "utf8") };
  });
  const refArtifacts = writeOpReferences(db, skillDir, args.productId);
  return { artifacts: [...topArtifacts, ...refArtifacts], oasJson, skillDir };
}

function writeOpReferences(
  db: Sqlite3Database,
  skillDir: string,
  productId: string,
): BuildArtifact[] {
  const refsDir = join(skillDir, "references");
  mkdirSync(refsDir, { recursive: true });
  const opIds = loadAllOpIds(db, productId);
  return opIds.map(opId => {
    const content = renderOpReference(db, opId, productId);
    const filePath = join(refsDir, `${opId}.md`);
    writeFileSync(filePath, content, "utf8");
    return { path: filePath, bytes: Buffer.byteLength(content, "utf8") };
  });
}

function loadAllOpIds(db: Sqlite3Database, productId: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT n.id
         FROM nodes n
         JOIN nodes s ON s.id = n.parent_id
        WHERE n.kind = 'operation' AND s.parent_id = ?
        ORDER BY n.id`,
    )
    .all(productId) as { id: string }[];
  return rows.map(r => r.id);
}

function renderSkill(db: Sqlite3Database, args: WriteArgs): string {
  return renderSkillMd({
    db,
    productId: args.productId,
    productName: args.productName,
    allowedTools: ["Read", "Bash"],
  });
}

function renderMcp(db: Sqlite3Database, args: WriteArgs): string {
  return renderMcpJson({
    db,
    productId: args.productId,
    serverName: slug(args.productName),
  });
}

function renderOas(db: Sqlite3Database, args: WriteArgs): string {
  return renderSyntheticOpenApi({
    db,
    productId: args.productId,
    productName: args.productName,
    overlay: args.codegenOverlay,
  });
}

function renderShortLlms(db: Sqlite3Database, args: WriteArgs): string {
  return renderLlmsTxt({
    db,
    productId: args.productId,
    productName: args.productName,
    productDescription: args.description,
  });
}

function renderFullLlms(db: Sqlite3Database, args: WriteArgs): string {
  return renderLlmsFullTxt({
    db,
    productId: args.productId,
    productName: args.productName,
    productDescription: args.description,
  });
}

function renderManifest(args: WriteArgs): string {
  const manifest = {
    product: { id: args.productId, domain: args.productName },
    sources: args.sources.map((s) => ({
      url: s.url,
      surface: s.surface,
      sha256: s.sha256,
      content_type: s.content_type,
    })),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function bytesLoaderFrom(
  sourcesDir: string,
): (sha256: string) => Promise<Buffer> {
  return async (sha256) => {
    if (!existsSync(sourcesDir)) {
      throw new Error(`runBuild: sources dir missing: ${sourcesDir}`);
    }
    const files = readdirSync(sourcesDir);
    const match = files.find((f) => f.startsWith(`${sha256}.`));
    if (match === undefined) {
      throw new Error(`runBuild: no source file for sha ${sha256}`);
    }
    return readFileSync(join(sourcesDir, match));
  };
}

function derivedProductId(domain: string): string {
  const h = createHash("sha1").update(domain).digest("hex").slice(0, 12);
  return `p-${h}`;
}

function displayName(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function defaultDescription(productName: string): string {
  return `Agent onboarding skill for ${productName}.`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
