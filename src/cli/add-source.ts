import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { inferSpecContentType } from "../discovery/specSniffer.js";
import { extensionFor } from "../sources/store.js";
import { scoreCoverage } from "../discovery/config.js";
import type { SurfaceKind } from "../graph/types.js";

// ---- Zod schema matching what init writes ---------------------------------

const SourceEntrySchema = z.object({
  surface: z.enum(["rest", "grpc", "cli", "mcp", "sdk", "docs", "llms_txt"]),
  url: z.string(),
  sha256: z.string(),
  content_type: z.string(),
  fetched_at: z.string(),
});

const ConfigSchema = z.object({
  product: z.object({
    domain: z.string(),
    github_org: z.string().nullable(),
  }),
  sources: z.array(SourceEntrySchema),
  coverage: z.enum(["bronze", "silver", "gold"]),
});

type ValidatedConfig = z.infer<typeof ConfigSchema>;

// ---- public types ----------------------------------------------------------

export interface AddSourceOptions {
  readonly url: string;
  readonly in?: string;
  readonly surface?: SurfaceKind;
  readonly timeoutMs?: number;
}

export interface AddSourceResult {
  readonly surface: SurfaceKind;
  readonly content_type: string;
  readonly sha256: string;
  readonly configPath: string;
}

export type FetchImpl = (url: string, opts?: RequestInit) => Promise<Response>;

// ---- helpers ---------------------------------------------------------------

function inferSurface(contentType: string): SurfaceKind {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    bare === "application/openapi+yaml" ||
    bare === "application/openapi+json" ||
    bare === "application/swagger+yaml" ||
    bare === "application/swagger+json" ||
    bare === "application/graphql"
  ) {
    return "rest";
  }
  return "docs";
}

function sniffContentType(bytes: Buffer, servedContentType: string): string {
  const bare = servedContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  // GraphQL SDL heuristic — check before passing to specSniffer
  if (isGraphqlSdl(bytes)) return "application/graphql";
  // Delegate OpenAPI/Swagger detection to specSniffer
  if (
    bare === "application/json" ||
    bare === "application/yaml" ||
    bare === "application/x-yaml" ||
    bare === "text/yaml" ||
    bare === "text/plain" ||
    bare.startsWith("application/vnd.oai")
  ) {
    return inferSpecContentType(bytes, bare);
  }
  return servedContentType;
}

function isGraphqlSdl(bytes: Buffer): boolean {
  const text = bytes.slice(0, 512).toString("utf8");
  return /\btype\s+Query\b/.test(text) || /\bschema\s*\{/.test(text);
}

function readConfig(configPath: string): ValidatedConfig {
  if (!existsSync(configPath)) {
    throw new Error(
      `skillship add-source: config not found at ${configPath}; run "skillship init" first`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(configPath, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`skillship add-source: config.yaml is not valid YAML — ${msg}`);
  }
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`skillship add-source: config.yaml schema error — ${issues}`);
  }
  return result.data;
}

function upsertSource(
  sources: ValidatedConfig["sources"],
  entry: ValidatedConfig["sources"][number],
): ValidatedConfig["sources"] {
  const idx = sources.findIndex((s) => s.url === entry.url);
  if (idx === -1) return [...sources, entry];
  return sources.map((s, i) => (i === idx ? entry : s));
}

function writeConfigFile(configPath: string, config: ValidatedConfig): void {
  const yaml = stringifyYaml({
    product: {
      domain: config.product.domain,
      github_org: config.product.github_org,
    },
    sources: config.sources.map((s) => ({
      surface: s.surface,
      url: s.url,
      sha256: s.sha256,
      content_type: s.content_type,
      fetched_at: s.fetched_at,
    })),
    coverage: config.coverage,
  });
  writeFileSync(configPath, yaml, "utf8");
}

function storeCacheFile(
  sourcesDir: string,
  sha256: string,
  ext: string,
  bytes: Buffer,
): string {
  mkdirSync(sourcesDir, { recursive: true });
  const cachePath = join(sourcesDir, `${sha256}.${ext}`);
  writeFileSync(cachePath, bytes);
  return cachePath;
}

// ---- core (testable) -------------------------------------------------------

export async function runAddSource(
  opts: AddSourceOptions,
  fetchImpl: FetchImpl,
): Promise<AddSourceResult> {
  const dir = opts.in ?? process.cwd();
  const configPath = join(dir, ".skillship", "config.yaml");
  const sourcesDir = join(dir, ".skillship", "sources");

  // 1. Fetch
  const controller = new AbortController();
  const abortTimeout =
    opts.timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : undefined;

  let response: Response;
  try {
    response = await fetchImpl(opts.url, { signal: controller.signal });
  } finally {
    if (abortTimeout !== undefined) clearTimeout(abortTimeout);
  }

  if (!response.ok) {
    throw new Error(
      `skillship add-source: fetch failed for ${opts.url} — HTTP ${response.status}`,
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  const servedContentType =
    response.headers.get("content-type") ?? "application/octet-stream";

  // 2. Sniff
  const sniffedContentType = sniffContentType(bytes, servedContentType);
  const surface: SurfaceKind = opts.surface ?? inferSurface(sniffedContentType);

  // 3. SHA-256 + cache
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ext = extensionFor(sniffedContentType);
  storeCacheFile(sourcesDir, sha256, ext, bytes);

  // 4. Config parse → upsert → recompute coverage → rewrite
  const config = readConfig(configPath);
  const newEntry = {
    surface,
    url: opts.url,
    sha256,
    content_type: sniffedContentType,
    fetched_at: new Date().toISOString(),
  };
  const updatedSources = upsertSource(config.sources, newEntry);
  const updatedConfig: ValidatedConfig = {
    ...config,
    sources: updatedSources,
    coverage: scoreCoverage(updatedSources.length),
  };
  writeConfigFile(configPath, updatedConfig);

  return { surface, content_type: sniffedContentType, sha256, configPath };
}

// ---- thin CLI wrapper (called from index.ts) --------------------------------

export async function cliAddSource(
  opts: AddSourceOptions,
): Promise<string> {
  const result = await runAddSource(opts, fetch);
  return `skillship add-source: added ${result.surface} source (coverage=${
    (() => {
      // Re-read fresh coverage from the config we just wrote
      const parsed = parseYaml(
        readFileSync(result.configPath, "utf8"),
      ) as { coverage: string };
      return parsed.coverage;
    })()
  })`;
}
