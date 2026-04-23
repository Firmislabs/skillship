import type { Database as Sqlite3Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertSource } from "../graph/repo.js";
import type { SourceNode, SurfaceKind } from "../graph/types.js";

const EXTENSION_MAP: Readonly<Record<string, string>> = {
  "application/json": "json",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "text/yaml": "yaml",
  "text/vnd.yaml": "yaml",
  "application/xml": "xml",
  "text/xml": "xml",
  "text/html": "html",
  "application/javascript": "js",
  "application/typescript": "ts",
  "application/openapi+yaml": "yaml",
  "application/openapi+json": "json",
  "application/swagger+yaml": "yaml",
  "application/swagger+json": "json",
  "application/x-openref-cli+yaml": "yaml",
  "application/x-openref-sdk+yaml": "yaml",
};

export function extensionFor(contentType: string): string {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return EXTENSION_MAP[bare] ?? "bin";
}

export interface StoreSourceInput {
  readonly url: string;
  readonly bytes: Buffer;
  readonly content_type: string;
  readonly surface: SurfaceKind;
}

export function storeSource(
  db: Sqlite3Database,
  sourcesDir: string,
  input: StoreSourceInput,
): SourceNode {
  const id = createHash("sha256").update(input.bytes).digest("hex");
  const ext = extensionFor(input.content_type);
  const cachePath = join(sourcesDir, `${id}.${ext}`);
  mkdirSync(sourcesDir, { recursive: true });
  writeFileSync(cachePath, input.bytes);
  const fetchedAt = new Date().toISOString();
  const row = upsertSource(db, {
    id,
    surface: input.surface,
    url: input.url,
    content_type: input.content_type,
    fetched_at: fetchedAt,
    bytes: input.bytes.length,
    cache_path: cachePath,
  });
  return {
    id: row.id,
    kind: "source",
    surface: row.surface,
    url: row.url,
    content_type: row.content_type,
    fetched_at: row.fetched_at,
    bytes: row.bytes,
    cache_path: row.cache_path,
  };
}
