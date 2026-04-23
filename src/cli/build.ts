import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Database as Sqlite3Database } from "better-sqlite3";
import { openGraph } from "../graph/db.js";
import { ingestConfig, type IngestSummary } from "../ingest/pipeline.js";
import { renderSkillMd } from "../renderers/skill.js";
import { renderMcpJson } from "../renderers/mcpJson.js";
import {
  renderLlmsTxt,
  renderLlmsFullTxt,
} from "../renderers/llmsTxt.js";
import type {
  ConfigSourceEntry,
  SkillshipConfig,
} from "../discovery/config.js";

export interface RunBuildOptions {
  readonly in: string;
  readonly out: string;
  readonly productId?: string;
  readonly description?: string;
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
  const dbPath = join(skDir, "graph.sqlite");
  const sourcesDir = join(skDir, "sources");
  const productId =
    opts.productId ?? derivedProductId(config.product.domain);
  const productName = config.product.domain;
  const description = opts.description ?? defaultDescription(productName);

  const handle = openGraph(dbPath);
  try {
    const ingest = await ingestConfig({
      db: handle.db,
      config,
      productId,
      loadBytes: bytesLoaderFrom(sourcesDir),
    });
    mkdirSync(opts.out, { recursive: true });
    const artifacts = writeAll(handle.db, opts.out, {
      productId,
      productName,
      description,
      sources: config.sources,
    });
    return { productId, artifacts, ingest };
  } finally {
    handle.close();
  }
}

interface WriteArgs {
  readonly productId: string;
  readonly productName: string;
  readonly description: string;
  readonly sources: readonly ConfigSourceEntry[];
}

function writeAll(
  db: Sqlite3Database,
  outDir: string,
  args: WriteArgs,
): BuildArtifact[] {
  const skillDir = join(outDir, "skills", slug(args.productName));
  mkdirSync(skillDir, { recursive: true });
  const entries: [string, string][] = [
    [join(skillDir, "SKILL.md"), renderSkill(db, args)],
    [join(outDir, ".mcp.json"), renderMcp(db, args)],
    [join(outDir, "llms.txt"), renderShortLlms(db, args)],
    [join(outDir, "llms-full.txt"), renderFullLlms(db, args)],
    [join(outDir, "manifest.json"), renderManifest(args)],
  ];
  return entries.map(([path, content]) => {
    writeFileSync(path, content, "utf8");
    return { path, bytes: Buffer.byteLength(content, "utf8") };
  });
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

function defaultDescription(productName: string): string {
  return `Agent onboarding skill for ${productName}.`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
