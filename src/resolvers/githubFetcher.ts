import { spawn } from "node:child_process";
import { classifySpecPath, type GithubBlob } from "./githubSpecs.js";

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
  const hits = tree.tree.filter(
    (e) =>
      e.type === "blob" &&
      !SKIP_DIR_RE.test(`/${e.path}`) &&
      classifySpecPath(e.path) !== null,
  );
  const out: GithubBlob[] = [];
  for (const hit of hits) {
    const blob = await fetchBlob(parsed, hit.sha, gh);
    if (blob !== null) out.push({ path: hit.path, bytes: blob });
  }
  return out;
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
