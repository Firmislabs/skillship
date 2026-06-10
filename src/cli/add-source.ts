import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { inferSpecContentType, isGraphqlSdl } from "../discovery/specSniffer.js";
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
  readonly coverage: "bronze" | "silver" | "gold";
}

export type FetchImpl = (url: string, opts?: RequestInit) => Promise<Response>;

// ---- valid surface kinds (mirrors SurfaceKind union) -----------------------

const VALID_SURFACES: ReadonlySet<string> = new Set([
  "rest", "grpc", "cli", "mcp", "sdk", "docs", "llms_txt",
]);

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
  // OpenAPI/Swagger classification FIRST (inferSpecContentType handles GraphQL too for yaml/json).
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
  // GraphQL SDL fallback for other text-ish content types.
  if (isGraphqlSdl(bytes)) return "application/graphql";
  return servedContentType;
}

function isBinaryish(servedContentType: string): boolean {
  const bare = servedContentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return bare === "application/octet-stream" || extensionFor(bare) === "bin";
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
): void {
  mkdirSync(sourcesDir, { recursive: true });
  writeFileSync(join(sourcesDir, `${sha256}.${ext}`), bytes);
}

async function fetchBytes(
  url: string,
  fetchImpl: FetchImpl,
  timeoutMs: number | undefined,
): Promise<{ bytes: Buffer; servedContentType: string }> {
  const controller = new AbortController();
  const abortTimeout =
    timeoutMs !== undefined
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: controller.signal });
  } finally {
    if (abortTimeout !== undefined) clearTimeout(abortTimeout);
  }
  if (!response.ok) {
    throw new Error(
      `skillship add-source: fetch failed for ${url} — HTTP ${response.status}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  const bytes = Buffer.from(arrayBuffer);
  const servedContentType = response.headers.get("content-type") ?? "application/octet-stream";
  return { bytes, servedContentType };
}

// ---- core (testable) -------------------------------------------------------

export async function runAddSource(
  opts: AddSourceOptions,
  fetchImpl: FetchImpl,
): Promise<AddSourceResult> {
  // 0. Validate --surface BEFORE any side effects.
  if (opts.surface !== undefined && !VALID_SURFACES.has(opts.surface)) {
    throw new Error(
      `skillship add-source: invalid --surface "${opts.surface}"; valid values: ${[...VALID_SURFACES].join(", ")}`,
    );
  }

  const dir = opts.in ?? process.cwd();
  const configPath = join(dir, ".skillship", "config.yaml");
  const sourcesDir = join(dir, ".skillship", "sources");

  // 1. Read + validate config FIRST (no side effects on error path).
  const config = readConfig(configPath);

  // 2. Fetch.
  const { bytes, servedContentType } = await fetchBytes(opts.url, fetchImpl, opts.timeoutMs);

  // 3. Sniff.
  const sniffedContentType = sniffContentType(bytes, servedContentType);

  // Error on binary-unknown with no --surface.
  if (opts.surface === undefined && isBinaryish(servedContentType) && sniffedContentType === servedContentType) {
    throw new Error(
      `skillship add-source: cannot infer surface for binary content (${servedContentType}); pass --surface with one of: ${[...VALID_SURFACES].join(", ")}`,
    );
  }

  const surface: SurfaceKind = opts.surface ?? inferSurface(sniffedContentType);

  // 4. SHA-256 + cache.
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const ext = extensionFor(sniffedContentType);
  storeCacheFile(sourcesDir, sha256, ext, bytes);

  // 5. Upsert → recompute coverage → rewrite config.
  const newEntry = {
    surface,
    url: opts.url,
    sha256,
    content_type: sniffedContentType,
    fetched_at: new Date().toISOString(),
  };
  const updatedSources = upsertSource(config.sources, newEntry);
  const coverage = scoreCoverage(updatedSources.length);
  const updatedConfig: ValidatedConfig = {
    ...config,
    sources: updatedSources,
    coverage,
  };
  writeConfigFile(configPath, updatedConfig);

  return { surface, content_type: sniffedContentType, sha256, configPath, coverage };
}

// ---- thin CLI wrapper (called from index.ts) --------------------------------

export async function cliAddSource(
  opts: AddSourceOptions,
): Promise<string> {
  const result = await runAddSource(opts, fetch);
  return `skillship add-source: added ${result.surface} source (coverage=${result.coverage})`;
}
