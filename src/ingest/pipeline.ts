import { createHash } from "node:crypto";
import type { Database as Sqlite3Database } from "better-sqlite3";
import type {
  ConfigSourceEntry,
  SkillshipConfig,
} from "../discovery/config.js";
import type { SourceNode } from "../graph/types.js";
import { getNode, insertNode, upsertSource } from "../graph/repo.js";
import { GITHUB_REPO_PLACEHOLDER } from "../resolvers/githubSpecs.js";
import { dispatchExtractor } from "./dispatch.js";
import { persistExtraction } from "./persist.js";

export interface IngestError {
  readonly url: string;
  readonly stage: "load" | "dispatch" | "persist";
  readonly message: string;
}

export interface IngestSummary {
  readonly sourcesProcessed: number;
  readonly sourcesSkipped: number;
  readonly sourcesFailed: number;
  readonly operations: number;
  readonly nodesInserted: number;
  readonly claimsInserted: number;
  readonly edgesInserted: number;
  readonly errors: IngestError[];
}

export interface IngestConfigInput {
  readonly db: Sqlite3Database;
  readonly config: SkillshipConfig;
  readonly productId: string;
  readonly loadBytes: (sha256: string) => Promise<Buffer>;
  readonly now?: () => string;
}

export async function ingestConfig(
  input: IngestConfigInput,
): Promise<IngestSummary> {
  const now = input.now ?? (() => new Date().toISOString());
  ensureProductNode(input.db, input.productId, now);

  let processed = 0;
  let skipped = 0;
  let failed = 0;
  let nodesInserted = 0;
  let claimsInserted = 0;
  let edgesInserted = 0;
  const errors: IngestError[] = [];

  for (const entry of input.config.sources) {
    if (entry.content_type === GITHUB_REPO_PLACEHOLDER) {
      skipped += 1;
      continue;
    }
    const outcome = await ingestOneEntry({
      db: input.db,
      entry,
      productId: input.productId,
      loadBytes: input.loadBytes,
      now,
    });
    if (outcome.error !== null) {
      failed += 1;
      errors.push(outcome.error);
      continue;
    }
    processed += 1;
    nodesInserted += outcome.nodesInserted;
    claimsInserted += outcome.claimsInserted;
    edgesInserted += outcome.edgesInserted;
  }

  return {
    sourcesProcessed: processed,
    sourcesSkipped: skipped,
    sourcesFailed: failed,
    operations: countOperations(input.db),
    nodesInserted,
    claimsInserted,
    edgesInserted,
    errors,
  };
}

interface EntryOutcome {
  readonly error: IngestError | null;
  readonly nodesInserted: number;
  readonly claimsInserted: number;
  readonly edgesInserted: number;
}

interface IngestOneInput {
  readonly db: Sqlite3Database;
  readonly entry: ConfigSourceEntry;
  readonly productId: string;
  readonly loadBytes: (sha256: string) => Promise<Buffer>;
  readonly now: () => string;
}

async function ingestOneEntry(input: IngestOneInput): Promise<EntryOutcome> {
  let bytes: Buffer;
  try {
    bytes = await input.loadBytes(input.entry.sha256);
  } catch (e) {
    return zeroOutcome(input.entry.url, "load", e);
  }
  const sourceNode = upsertSourceFromBytes(input.db, input.entry, bytes);
  let extraction;
  try {
    extraction = await dispatchExtractor({
      bytes,
      source: sourceNode,
      productId: input.productId,
    });
  } catch (e) {
    return zeroOutcome(input.entry.url, "dispatch", e);
  }
  if (extraction === null) return zeroOk();
  try {
    const summary = persistExtraction(input.db, extraction, { now: input.now });
    return {
      error: null,
      nodesInserted: summary.nodesInserted,
      claimsInserted: summary.claimsInserted,
      edgesInserted: summary.edgesInserted,
    };
  } catch (e) {
    return zeroOutcome(input.entry.url, "persist", e);
  }
}

function upsertSourceFromBytes(
  db: Sqlite3Database,
  entry: ConfigSourceEntry,
  bytes: Buffer,
): SourceNode {
  const sourceId = createHash("sha256").update(bytes).digest("hex");
  const row = upsertSource(db, {
    id: sourceId,
    surface: entry.surface,
    url: entry.url,
    content_type: entry.content_type,
    fetched_at: entry.fetched_at,
    bytes: bytes.length,
    cache_path: `memory://${sourceId}`,
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

function zeroOutcome(
  url: string,
  stage: IngestError["stage"],
  e: unknown,
): EntryOutcome {
  return {
    error: { url, stage, message: errMessage(e) },
    nodesInserted: 0,
    claimsInserted: 0,
    edgesInserted: 0,
  };
}

function zeroOk(): EntryOutcome {
  return { error: null, nodesInserted: 0, claimsInserted: 0, edgesInserted: 0 };
}

function ensureProductNode(
  db: Sqlite3Database,
  productId: string,
  now: () => string,
): void {
  if (getNode(db, productId) !== null) return;
  const ts = now();
  insertNode(db, {
    id: productId,
    kind: "product",
    parent_id: null,
    created_at: ts,
    updated_at: ts,
  });
}

function countOperations(db: Sqlite3Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind='operation'")
    .get() as { c: number };
  return row.c;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
