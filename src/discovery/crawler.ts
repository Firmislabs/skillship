import type { SurfaceKind } from "../graph/types.js";
import { isValidLlmsTxt } from "./sniffer.js";

export interface ProbeTarget {
  readonly surface: SurfaceKind;
  readonly url: string;
  readonly validate?: (contentType: string, body: string) => boolean;
}

export interface CrawlResult {
  readonly surface: SurfaceKind;
  readonly url: string;
  readonly content_type: string;
  readonly bytes: Buffer;
}

export interface CrawlFailure {
  readonly kind: "failure";
  readonly url: string;
  readonly reason: string;
}

export type ProbeOutcome =
  | { kind: "success"; result: CrawlResult }
  | CrawlFailure;

export function normalizeBase(domainOrUrl: string): URL {
  const hasScheme = /^https?:\/\//i.test(domainOrUrl);
  const raw = hasScheme ? domainOrUrl : `https://${domainOrUrl}`;
  return new URL(raw);
}

function isNonPublicHost(hostname: string): boolean {
  if (hostname === "localhost") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  return false;
}

const REST_PROBE_PATHS = [
  "/api/openapi.json",
  "/api/v1/openapi.json",
  "/openapi.json",
  "/swagger.json",
  "/api/schema/",
  "/swagger.v1.json",
  "/v3/api-docs",
  "/api-docs/v2/swagger.json",
];

const API_SUBHOSTS = ["app", "api"] as const;

export function buildProbeTargets(base: URL): ProbeTarget[] {
  const targets: ProbeTarget[] = [
    {
      surface: "llms_txt",
      url: new URL("/llms.txt", base).toString(),
      validate: isValidLlmsTxt,
    },
    { surface: "docs", url: new URL("/sitemap.xml", base).toString() },
    { surface: "docs", url: new URL("/docs/sitemap.xml", base).toString() },
  ];
  for (const p of REST_PROBE_PATHS) {
    targets.push({ surface: "rest", url: new URL(p, base).toString() });
  }
  if (!isNonPublicHost(base.hostname)) {
    for (const sub of API_SUBHOSTS) {
      for (const p of REST_PROBE_PATHS) {
        const url = `${base.protocol}//${sub}.${base.hostname}${p}`;
        targets.push({ surface: "rest", url });
      }
    }
    const mcpUrl = `${base.protocol}//mcp.${base.hostname}/.well-known/oauth-protected-resource/mcp`;
    targets.push({ surface: "mcp", url: mcpUrl });
  }
  return targets;
}

async function readBodyWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ contentType: string; bytes: Buffer } | CrawlFailure> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      return { kind: "failure", url, reason: `status ${res.status}` };
    }
    const contentType =
      res.headers.get("content-type") ?? "application/octet-stream";
    const ab = await res.arrayBuffer();
    return { contentType, bytes: Buffer.from(ab) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "failure", url, reason: `fetch error: ${message}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeOne(
  target: ProbeTarget,
  timeoutMs: number,
): Promise<ProbeOutcome> {
  const read = await readBodyWithTimeout(target.url, timeoutMs);
  if ("kind" in read) return read;
  if (target.validate) {
    const body = read.bytes.toString("utf8");
    if (!target.validate(read.contentType, body)) {
      return { kind: "failure", url: target.url, reason: "validate rejected" };
    }
  }
  return {
    kind: "success",
    result: {
      surface: target.surface,
      url: target.url,
      content_type: read.contentType,
      bytes: read.bytes,
    },
  };
}

export interface CrawlOptions {
  readonly timeoutMs?: number;
}

export async function crawlDomain(
  domainOrUrl: string,
  opts: CrawlOptions = {},
): Promise<CrawlResult[]> {
  const base = normalizeBase(domainOrUrl);
  const targets = buildProbeTargets(base);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const outcomes = await Promise.all(
    targets.map((t) => probeOne(t, timeoutMs)),
  );
  return outcomes
    .filter((o): o is { kind: "success"; result: CrawlResult } =>
      o.kind === "success",
    )
    .map((o) => o.result);
}
