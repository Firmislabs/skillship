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
import { inferSpecContentType } from "../discovery/specSniffer.js";
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
import { extractLlmsTxt } from "../extractors/llmsTxt.js";
import {
  fetchAuthDocPages,
  type AuthDocPage,
} from "../discovery/authLinkFollow.js";

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

function refineCrawlResult(r: CrawlResult): CrawlResult {
  if (r.surface !== "rest") return r;
  const inferred = inferSpecContentType(r.bytes, r.content_type);
  if (inferred === r.content_type) return r;
  return { ...r, content_type: inferred };
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
      const normalized = refineCrawlResult(r);
      const node = storeSource(handle.db, sourcesDir, {
        url: normalized.url,
        bytes: normalized.bytes,
        content_type: normalized.content_type,
        surface: normalized.surface,
      });
      entries.push(crawlResultToEntry(normalized, node.id, node.fetched_at));
    }
    const authPages = await fetchAuthDocPagesFromCrawl(crawled, fetchOpts.timeoutMs);
    for (const r of authPages) {
      const node = storeSource(handle.db, sourcesDir, {
        url: r.url,
        bytes: r.bytes,
        content_type: r.content_type,
        surface: r.surface,
      });
      entries.push(crawlResultToEntry(r, node.id, node.fetched_at));
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

function makeFakeSource(url: string): import("../graph/types.js").SourceNode {
  return {
    id: `fake-${url}`,
    kind: "source",
    surface: "llms_txt",
    url,
    content_type: "text/plain",
    fetched_at: new Date().toISOString(),
    bytes: 0,
    cache_path: "",
  };
}

function extractAuthDocPages(
  llmsResult: CrawlResult,
): AuthDocPage[] {
  const extraction = extractLlmsTxt({
    bytes: llmsResult.bytes,
    source: makeFakeSource(llmsResult.url),
    productId: "init",
  });
  const urlByNode = new Map<string, string>();
  const titleByNode = new Map<string, string>();
  const categoryByNode = new Map<string, string>();
  for (const c of extraction.claims) {
    if (c.field === "url") urlByNode.set(c.node_id, String(c.value));
    if (c.field === "title") titleByNode.set(c.node_id, String(c.value));
    if (c.field === "category") categoryByNode.set(c.node_id, String(c.value));
  }
  const pages: AuthDocPage[] = [];
  for (const [nodeId, url] of urlByNode) {
    pages.push({
      url,
      title: titleByNode.get(nodeId) ?? "",
      category: categoryByNode.get(nodeId) ?? "",
    });
  }
  return pages;
}

async function fetchAuthDocPagesFromCrawl(
  crawled: CrawlResult[],
  timeoutMs: number | undefined,
): Promise<CrawlResult[]> {
  const llmsTxt = crawled.find(r => r.surface === "llms_txt");
  if (llmsTxt === undefined) return [];
  const pages = extractAuthDocPages(llmsTxt);
  return fetchAuthDocPages({ pages, timeoutMs });
}
