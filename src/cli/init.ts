import { createHash } from "node:crypto";
import { join } from "node:path";
import { openGraph } from "../graph/db.js";
import {
  buildConfig,
  writeConfig,
  type ConfigSourceEntry,
  type SkillshipConfig,
} from "../discovery/config.js";
import { crawlDomain, type CrawlResult } from "../discovery/crawler.js";
import {
  discoverGithubSignals,
  realGhRepoLister,
  type GhRepoLister,
  type GithubRepo,
} from "../discovery/github.js";
import {
  fetchGithubRepoBlobs,
  type GhInvoker,
} from "../resolvers/githubFetcher.js";
import {
  resolveGithubSpecs,
  type GithubRepoFetcher,
} from "../resolvers/githubSpecs.js";
import { storeSource } from "../sources/store.js";
import type { SurfaceKind } from "../graph/types.js";

export interface InitOptions {
  readonly domain: string;
  readonly github?: string | null;
  readonly out?: string;
  readonly timeoutMs?: number;
  readonly githubLister?: GhRepoLister;
  readonly githubRepoFetcher?: GithubRepoFetcher;
  readonly ghInvoker?: GhInvoker;
}

export interface InitResult {
  readonly configPath: string;
  readonly config: SkillshipConfig;
}

function inferSurfaceFromRepoName(name: string): SurfaceKind {
  const n = name.toLowerCase();
  if (n.includes("mcp")) return "mcp";
  if (n.includes("cli")) return "cli";
  if (n.includes("openapi") || n.includes("swagger")) return "rest";
  return "sdk";
}

function crawlResultToEntry(
  res: CrawlResult,
  sha256: string,
  fetchedAt: string,
): ConfigSourceEntry {
  return {
    surface: res.surface,
    url: res.url,
    sha256,
    content_type: res.content_type,
    fetched_at: fetchedAt,
  };
}

function repoToEntry(repo: GithubRepo): ConfigSourceEntry {
  const url = repo.html_url ?? `https://github.com/${repo.name}`;
  const sha256 = createHash("sha256").update(url).digest("hex");
  return {
    surface: inferSurfaceFromRepoName(repo.name),
    url,
    sha256,
    content_type: "application/vnd.github.repo",
    fetched_at: new Date().toISOString(),
  };
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const outDir = opts.out ?? process.cwd();
  const skillshipDir = join(outDir, ".skillship");
  const dbPath = join(skillshipDir, "graph.sqlite");
  const sourcesDir = join(skillshipDir, "sources");
  const configPath = join(skillshipDir, "config.yaml");

  const handle = openGraph(dbPath);
  const entries: ConfigSourceEntry[] = [];
  const fetchOpts =
    opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
  try {
    const crawled = await crawlDomain(opts.domain, fetchOpts);
    for (const r of crawled) {
      const node = storeSource(handle.db, sourcesDir, {
        url: r.url,
        bytes: r.bytes,
        content_type: r.content_type,
        surface: r.surface,
      });
      entries.push(
        crawlResultToEntry(r, node.id, node.fetched_at),
      );
    }
    if (opts.github) {
      const lister = opts.githubLister ?? realGhRepoLister;
      const hits = await discoverGithubSignals(opts.github, lister);
      for (const repo of hits) entries.push(repoToEntry(repo));
    }
    const fetcher = pickFetcher(opts);
    const expanded =
      fetcher === null
        ? entries
        : await resolveGithubSpecs(entries, fetcher, {
            persist: (p) => {
              storeSource(handle.db, sourcesDir, {
                url: p.url,
                bytes: p.bytes,
                content_type: p.content_type,
                surface: p.surface,
              });
            },
          });
    const config = buildConfig({
      domain: opts.domain,
      github_org: opts.github ?? null,
      sources: expanded,
    });
    writeConfig(configPath, config);
    return { configPath, config };
  } finally {
    handle.close();
  }
}

function pickFetcher(opts: InitOptions): GithubRepoFetcher | null {
  if (opts.githubRepoFetcher !== undefined) return opts.githubRepoFetcher;
  if (opts.ghInvoker !== undefined) {
    const invoker = opts.ghInvoker;
    return (url) => fetchGithubRepoBlobs(url, invoker);
  }
  return null;
}
