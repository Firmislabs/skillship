import { createHash } from "node:crypto";
import type { ConfigSourceEntry } from "../discovery/config.js";
import type { SurfaceKind } from "../graph/types.js";

export const GITHUB_REPO_PLACEHOLDER = "application/vnd.github.repo";

export interface GithubBlob {
  readonly path: string;
  readonly bytes: Buffer;
}

export type GithubRepoFetcher = (
  repoUrl: string,
) => Promise<readonly GithubBlob[]>;

export interface PersistBlobInput {
  readonly bytes: Buffer;
  readonly surface: SurfaceKind;
  readonly content_type: string;
  readonly url: string;
}

export type PersistBlob = (input: PersistBlobInput) => void | Promise<void>;

export interface ResolveGithubSpecsOptions {
  readonly now?: () => string;
  readonly persist?: PersistBlob;
}

interface SpecClassification {
  readonly surface: SurfaceKind;
  readonly content_type: string;
}

export async function resolveGithubSpecs(
  entries: readonly ConfigSourceEntry[],
  fetcher: GithubRepoFetcher,
  opts: ResolveGithubSpecsOptions = {},
): Promise<ConfigSourceEntry[]> {
  const now = opts.now ?? (() => new Date().toISOString());
  const out: ConfigSourceEntry[] = [];
  for (const entry of entries) {
    if (entry.content_type !== GITHUB_REPO_PLACEHOLDER) {
      out.push(entry);
      continue;
    }
    const expanded = await expandRepo(entry, fetcher, now, opts.persist);
    for (const e of expanded) out.push(e);
  }
  return out;
}

async function expandRepo(
  entry: ConfigSourceEntry,
  fetcher: GithubRepoFetcher,
  now: () => string,
  persist: PersistBlob | undefined,
): Promise<ConfigSourceEntry[]> {
  const blobs = await fetcher(entry.url);
  const fetchedAt = now();
  const out: ConfigSourceEntry[] = [];
  for (const blob of blobs) {
    const cls = classifySpecPath(blob.path);
    if (cls === null) continue;
    const surface = pickSurface(entry.surface, cls.surface);
    const url = `${entry.url}/blob/HEAD/${blob.path}`;
    if (persist !== undefined) {
      await persist({
        bytes: blob.bytes,
        surface,
        content_type: cls.content_type,
        url,
      });
    }
    out.push({
      surface,
      url,
      sha256: createHash("sha256").update(blob.bytes).digest("hex"),
      content_type: cls.content_type,
      fetched_at: fetchedAt,
    });
  }
  return out;
}

function pickSurface(
  placeholder: SurfaceKind,
  classified: SurfaceKind,
): SurfaceKind {
  return classified !== "docs" ? classified : placeholder;
}

export function classifySpecPath(path: string): SpecClassification | null {
  const lower = path.toLowerCase();
  if (isRejectedPath(lower)) return null;
  const filename = lower.split("/").pop() ?? "";
  if (isRejectedFilename(filename)) return null;
  const openapi = matchOpenapi(filename);
  if (openapi !== null) return openapi;
  const swagger = matchSwagger(filename);
  if (swagger !== null) return swagger;
  const openref = matchOpenref(lower);
  if (openref !== null) return openref;
  const graphql = matchGraphql(filename);
  if (graphql !== null) return graphql;
  return null;
}

const REJECTED_SEGMENTS = new Set([
  ".github",
  "__snapshots__",
  "tests",
  "test",
  "examples",
  "example",
  "fixtures",
  "__tests__",
  "__fixtures__",
]);

function isRejectedPath(lowerPath: string): boolean {
  const segments = lowerPath.split("/");
  for (const seg of segments.slice(0, -1)) {
    if (REJECTED_SEGMENTS.has(seg)) return true;
  }
  return false;
}

function isRejectedFilename(filename: string): boolean {
  if (filename.includes("problem-matcher")) return true;
  if (filename.includes("codegen")) return true;
  if (filename.includes(".config.")) return true;
  if (filename.includes(".stub.")) return true;
  return false;
}

function matchOpenapi(filename: string): SpecClassification | null {
  if (!filename.includes("openapi")) return null;
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) {
    return { surface: "rest", content_type: "application/openapi+yaml" };
  }
  if (filename.endsWith(".json")) {
    return { surface: "rest", content_type: "application/openapi+json" };
  }
  return null;
}

function matchSwagger(filename: string): SpecClassification | null {
  if (!filename.includes("swagger")) return null;
  if (filename.endsWith(".yaml") || filename.endsWith(".yml")) {
    return { surface: "rest", content_type: "application/swagger+yaml" };
  }
  if (filename.endsWith(".json")) {
    return { surface: "rest", content_type: "application/swagger+json" };
  }
  return null;
}

function matchGraphql(filename: string): SpecClassification | null {
  if (filename.endsWith(".graphql") || filename.endsWith(".gql")) {
    return { surface: "rest", content_type: "application/graphql" };
  }
  return null;
}

function matchOpenref(lowerPath: string): SpecClassification | null {
  if (!lowerPath.endsWith(".yaml") && !lowerPath.endsWith(".yml")) return null;
  if (lowerPath.includes("openref/cli/") || lowerPath.endsWith("/cli.yaml")) {
    return {
      surface: "cli",
      content_type: "application/x-openref-cli+yaml",
    };
  }
  if (lowerPath.includes("openref/")) {
    return {
      surface: "sdk",
      content_type: "application/x-openref-sdk+yaml",
    };
  }
  return null;
}
