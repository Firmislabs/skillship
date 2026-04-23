import { spawn } from "node:child_process";
import { classifySpecPath, type GithubBlob } from "./githubSpecs.js";
import { bundleOpenapiRefs } from "./openapiBundle.js";
import { resolveStainlessSpec, type FetchUrl } from "./stainless.js";

export interface ParsedRepoUrl {
  readonly owner: string;
  readonly name: string;
}

export type GhInvoker = (args: readonly string[]) => Promise<string>;

const SKIP_DIR_RE = /(^|\/)(node_modules|dist|build|\.git|\.next|target|vendor)\//;

export function parseGithubRepoUrl(url: string): ParsedRepoUrl | null {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?\/?(?:[?#]|$)/,
  );
  if (m === null) return null;
  const [, owner, name] = m;
  if (!owner || !name) return null;
  return { owner, name };
}

export async function fetchGithubRepoBlobs(
  repoUrl: string,
  gh: GhInvoker = realGhInvoker,
  fetchUrl: FetchUrl = realFetchUrl,
): Promise<GithubBlob[]> {
  const parsed = parseGithubRepoUrl(repoUrl);
  if (parsed === null) return [];
  let treeRaw: string;
  try {
    treeRaw = await gh([
      "api",
      `repos/${parsed.owner}/${parsed.name}/git/trees/HEAD?recursive=1`,
    ]);
  } catch (e) {
    // HTTP 409 = empty repo, 404 = moved/private. Treat as "no specs found"
    // so a single problem repo in an org doesn't sink the whole init.
    const msg = e instanceof Error ? e.message : String(e);
    if (/HTTP 40[49]/.test(msg)) return [];
    throw e;
  }
  const tree = JSON.parse(treeRaw) as TreeResponse;
  if (tree.truncated === true || !Array.isArray(tree.tree)) return [];
  const pathToSha = indexTree(tree.tree);
  const out: GithubBlob[] = [];
  const stainless = await expandStainless(parsed, pathToSha, gh, fetchUrl);
  if (stainless !== null) out.push(stainless);
  const hits = tree.tree.filter(
    (e) =>
      e.type === "blob" &&
      !SKIP_DIR_RE.test(`/${e.path}`) &&
      classifySpecPath(e.path) !== null,
  );
  for (const hit of hits) {
    const blob = await fetchBlob(parsed, hit.sha, gh);
    if (blob === null) continue;
    const bytes = isOpenapiSpec(hit.path)
      ? await bundleOpenapiRefs(blob, hit.path, makeGetBlob(parsed, pathToSha, gh))
      : blob;
    out.push({ path: hit.path, bytes });
  }
  return out;
}

async function expandStainless(
  parsed: ParsedRepoUrl,
  pathToSha: ReadonlyMap<string, string>,
  gh: GhInvoker,
  fetchUrl: FetchUrl,
): Promise<GithubBlob | null> {
  const sha = pathToSha.get(".stats.yml");
  if (sha === undefined) return null;
  const statsBytes = await fetchBlob(parsed, sha, gh);
  if (statsBytes === null) return null;
  const resolved = await resolveStainlessSpec(statsBytes, fetchUrl);
  if (resolved === null) return null;
  return { path: resolved.path, bytes: resolved.bytes };
}

const realFetchUrl: FetchUrl = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
};

function indexTree(entries: readonly TreeEntry[]): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.type === "blob") map.set(e.path, e.sha);
  }
  return map;
}

function isOpenapiSpec(path: string): boolean {
  const cls = classifySpecPath(path);
  if (cls === null) return false;
  return (
    cls.content_type === "application/openapi+yaml" ||
    cls.content_type === "application/openapi+json" ||
    cls.content_type === "application/swagger+yaml" ||
    cls.content_type === "application/swagger+json"
  );
}

function makeGetBlob(
  parsed: ParsedRepoUrl,
  pathToSha: ReadonlyMap<string, string>,
  gh: GhInvoker,
): (path: string) => Promise<Buffer | null> {
  return async (path) => {
    const sha = pathToSha.get(path);
    if (sha === undefined) return null;
    return fetchBlob(parsed, sha, gh);
  };
}

async function fetchBlob(
  parsed: ParsedRepoUrl,
  sha: string,
  gh: GhInvoker,
): Promise<Buffer | null> {
  const raw = await gh([
    "api",
    `repos/${parsed.owner}/${parsed.name}/git/blobs/${sha}`,
  ]);
  const obj = JSON.parse(raw) as BlobResponse;
  if (obj.encoding !== "base64" || typeof obj.content !== "string") {
    return null;
  }
  return Buffer.from(obj.content, "base64");
}

export const realGhInvoker: GhInvoker = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("gh", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });

interface TreeResponse {
  readonly tree?: TreeEntry[];
  readonly truncated?: boolean;
}

interface TreeEntry {
  readonly path: string;
  readonly type: string;
  readonly sha: string;
}

interface BlobResponse {
  readonly content?: string;
  readonly encoding?: string;
}
