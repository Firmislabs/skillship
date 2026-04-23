import { spawn } from "node:child_process";

export interface GithubRepo {
  readonly name: string;
  readonly html_url?: string;
  readonly clone_url?: string;
  readonly description?: string | null;
}

export type GhRepoLister = (org: string) => Promise<GithubRepo[]>;

// Heuristic match for vendor signal repos. Starts from the brief's
// `openapi|cli|mcp|sdk` and adds the common SDK language-suffix pattern
// (`-js`, `-py`, `-go`, `-dart`, `-rb`, `-rs`) — Supabase, Vercel,
// Stripe and most SaaS vendors name SDK repos as `<product>-<lang>`
// rather than including the literal substring `sdk`, so without the
// extension the literal regex misses ~all real SDK repos.
const SIGNAL_RE = /openapi|swagger|cli|mcp|sdk|-(?:js|py|go|dart|rb|rs)(?:$|[-_/])/i;

export function matchSignalRepos(repos: GithubRepo[]): GithubRepo[] {
  return repos.filter((r) => SIGNAL_RE.test(r.name));
}

function parseGhLines(stdout: string): GithubRepo[] {
  const repos: GithubRepo[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const name = parts[0] ?? "";
    if (!name) continue;
    const htmlUrl = parts[1];
    const description = parts[2];
    repos.push({
      name,
      ...(htmlUrl ? { html_url: htmlUrl } : {}),
      ...(description !== undefined ? { description } : {}),
    });
  }
  return repos;
}

interface GhRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

function runGh(args: string[]): Promise<GhRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (err) => reject(err));
    child.on("close", (code) =>
      resolve({ stdout, stderr, code: code ?? -1 }),
    );
  });
}

export const realGhRepoLister: GhRepoLister = async (org) => {
  const args = [
    "api",
    `orgs/${org}/repos`,
    "--paginate",
    "-q",
    ".[] | [.name, .html_url, (.description // \"\")] | @tsv",
  ];
  const { stdout, stderr, code } = await runGh(args);
  if (code !== 0) {
    throw new Error(
      `gh api orgs/${org}/repos failed (exit ${code}): ${stderr.trim()}`,
    );
  }
  return parseGhLines(stdout);
};

export async function discoverGithubSignals(
  org: string,
  lister: GhRepoLister = realGhRepoLister,
): Promise<GithubRepo[]> {
  const repos = await lister(org);
  return matchSignalRepos(repos);
}
