export interface StainlessSpec {
  readonly path: string;
  readonly bytes: Buffer;
}

export type FetchUrl = (url: string) => Promise<Buffer>;

const SPEC_URL_RE = /^openapi_spec_url\s*:\s*['"]?([^\s'"]+)['"]?\s*$/m;

export async function resolveStainlessSpec(
  statsBytes: Buffer,
  fetchUrl: FetchUrl,
): Promise<StainlessSpec | null> {
  const match = statsBytes.toString("utf8").match(SPEC_URL_RE);
  if (match === null) return null;
  const url = match[1];
  if (url === undefined || url === "") return null;
  try {
    const bytes = await fetchUrl(url);
    if (bytes.length === 0) return null;
    return { path: specPathForUrl(url), bytes };
  } catch {
    return null;
  }
}

function specPathForUrl(url: string): string {
  const lower = url.toLowerCase();
  if (lower.endsWith(".json")) return "openapi.json";
  return "openapi.yml";
}
