import type { CrawlResult } from "./crawler.js";

const AUTH_CATEGORY_RE = /^authentication$/i;
const AUTH_TITLE_RE = /auth|oauth|api[\s-]?key/i;
const MAX_AUTH_FETCHES = 5;

export interface AuthDocPage {
  readonly url: string;
  readonly category: string;
  readonly title: string;
}

export interface AuthDocFetchInput {
  readonly pages: readonly AuthDocPage[];
  readonly timeoutMs?: number | undefined;
}

export function filterAuthDocUrls(pages: readonly AuthDocPage[]): string[] {
  const eligible = pages.filter(isAuthPage).map(p => p.url).filter(isSafeMarkdownUrl);
  return eligible.slice(0, MAX_AUTH_FETCHES);
}

export async function fetchAuthDocPages(
  input: AuthDocFetchInput,
): Promise<CrawlResult[]> {
  const urls = filterAuthDocUrls(input.pages);
  return fetchUrlsAsDocPages(urls, input.timeoutMs ?? 10_000);
}

export async function fetchUrlsAsDocPages(
  urls: readonly string[],
  timeoutMs: number,
): Promise<CrawlResult[]> {
  // Only require .md extension here; HTTPS is enforced upstream by filterAuthDocUrls.
  const mdUrls = urls.filter(isMarkdownUrl);
  const capped = mdUrls.slice(0, MAX_AUTH_FETCHES);
  const results = await Promise.all(capped.map(url => fetchOne(url, timeoutMs)));
  return results.filter((r): r is CrawlResult => r !== null);
}

function isAuthPage(page: AuthDocPage): boolean {
  return AUTH_CATEGORY_RE.test(page.category) || AUTH_TITLE_RE.test(page.title);
}

function isSafeMarkdownUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.pathname.endsWith(".md");
  } catch {
    return false;
  }
}

function isMarkdownUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith(".md");
  } catch {
    return false;
  }
}

async function fetchOne(
  url: string,
  timeoutMs: number,
): Promise<CrawlResult | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      console.warn(`authLinkFollow: ${url} returned ${res.status}`);
      return null;
    }
    const contentType =
      res.headers.get("content-type") ?? "text/markdown";
    const ab = await res.arrayBuffer();
    return {
      surface: "docs",
      url,
      content_type: contentType,
      bytes: Buffer.from(ab),
    };
  } catch (err) {
    console.warn(`authLinkFollow: fetch failed for ${url}:`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
