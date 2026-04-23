import type { Database as Sqlite3Database } from "better-sqlite3";
import { DEFAULT_PRECEDENCE } from "../graph/merge.js";
import type { SurfaceKind } from "../graph/types.js";

export interface RenderSkillMdInput {
  readonly db: Sqlite3Database;
  readonly productId: string;
  readonly productName: string;
  readonly allowedTools: readonly string[];
  readonly operationIndexCap?: number;
}

interface OperationView {
  readonly id: string;
  readonly method: string | undefined;
  readonly pathOrName: string | undefined;
  readonly summary: string | undefined;
}

interface SurfaceView {
  readonly id: string;
  readonly kind: SurfaceKind;
  readonly operations: OperationView[];
}

interface ProductView {
  readonly name: string;
  readonly description: string | undefined;
  readonly surfaces: SurfaceView[];
}

const DEFAULT_CAP = 50;

export function renderSkillMd(input: RenderSkillMdInput): string {
  const cap = input.operationIndexCap ?? DEFAULT_CAP;
  const view = buildView(input);
  const allOps = view.surfaces.flatMap((s) => s.operations);
  const frontmatter = renderFrontmatter({
    name: slug(input.productName),
    description: view.description ?? defaultDescription(input.productName),
    allowedTools: input.allowedTools,
  });
  const body = [
    `# ${input.productName}`,
    "",
    describeProduct(view),
    "",
    "## Surfaces",
    "",
    renderSurfaces(view.surfaces),
    "",
    "## Operations",
    "",
    renderOperationIndex(allOps, cap),
  ].join("\n");
  return `${frontmatter}\n\n${body}\n`;
}

function buildView(input: RenderSkillMdInput): ProductView {
  const surfaces = loadSurfaces(input.db, input.productId);
  return {
    name: input.productName,
    description: readBestClaim(input.db, input.productId, "description"),
    surfaces,
  };
}

function loadSurfaces(
  db: Sqlite3Database,
  productId: string,
): SurfaceView[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE kind='surface' AND parent_id=? ORDER BY id`,
    )
    .all(productId) as { id: string }[];
  return rows.map((r) => ({
    id: r.id,
    kind: (readBestClaim(db, r.id, "type") ?? "rest") as SurfaceKind,
    operations: loadOperations(db, r.id),
  }));
}

function loadOperations(
  db: Sqlite3Database,
  surfaceId: string,
): OperationView[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE kind='operation' AND parent_id=? ORDER BY id`,
    )
    .all(surfaceId) as { id: string }[];
  return rows.map((r) => ({
    id: r.id,
    method: readBestClaim(db, r.id, "method"),
    pathOrName: readBestClaim(db, r.id, "path_or_name"),
    summary: readBestClaim(db, r.id, "summary"),
  }));
}

function readBestClaim(
  db: Sqlite3Database,
  nodeId: string,
  field: string,
): string | undefined {
  const rows = db
    .prepare(
      `SELECT value_json, extractor, confidence FROM claims
       WHERE node_id=? AND field=? ORDER BY id`,
    )
    .all(nodeId, field) as {
    value_json: string;
    extractor: string;
    confidence: string;
  }[];
  if (rows.length === 0) return undefined;
  const scored = rows.map((r) => ({
    r,
    score: DEFAULT_PRECEDENCE.extractor[r.extractor] ?? 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!.r;
  const v = JSON.parse(best.value_json);
  return typeof v === "string" ? v : undefined;
}

function renderFrontmatter(fm: {
  name: string;
  description: string;
  allowedTools: readonly string[];
}): string {
  const tools = fm.allowedTools.join(", ");
  const desc = fm.description.replace(/\n+/g, " ").trim();
  return ["---", `name: ${fm.name}`, `description: ${desc}`, `allowed-tools: ${tools}`, "---"].join("\n");
}

function describeProduct(view: ProductView): string {
  if (view.description !== undefined) return view.description;
  return `Agent-onboarding skill for ${view.name}.`;
}

function renderSurfaces(surfaces: readonly SurfaceView[]): string {
  if (surfaces.length === 0) return "_No surfaces discovered._";
  return surfaces
    .map((s) => `- ${s.kind} — ${s.operations.length} operation${s.operations.length === 1 ? "" : "s"}`)
    .join("\n");
}

function renderOperationIndex(
  ops: readonly OperationView[],
  cap: number,
): string {
  if (ops.length === 0) return "_No operations discovered._";
  const shown = ops.slice(0, cap);
  const lines = shown.map(renderOperationLine);
  if (ops.length > cap) lines.push(`\n+ ${ops.length - cap} more operations (see references/)`);
  return lines.join("\n");
}

function renderOperationLine(op: OperationView): string {
  const method = (op.method ?? "OP").toUpperCase();
  const path = op.pathOrName ?? op.id;
  const summary = op.summary !== undefined ? ` — ${op.summary}` : "";
  return `- \`${method} ${path}\`${summary} ([details](references/${op.id}.md))`;
}

function defaultDescription(productName: string): string {
  return `Agent onboarding skill for ${productName}.`;
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
