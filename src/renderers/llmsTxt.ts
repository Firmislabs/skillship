import type { Database as Sqlite3Database } from "better-sqlite3";
import { readBestClaim } from "./claims.js";

export interface RenderLlmsTxtInput {
  readonly db: Sqlite3Database;
  readonly productId: string;
  readonly productName: string;
  readonly productDescription: string;
}

interface PageView {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly category: string;
  readonly tier: "core" | "optional";
}

const DEFAULT_CATEGORY = "Docs";

export function renderLlmsTxt(input: RenderLlmsTxtInput): string {
  return renderWithFilter(input, (p) => p.tier !== "optional");
}

export function renderLlmsFullTxt(input: RenderLlmsTxtInput): string {
  return renderWithFilter(input, () => true);
}

function renderWithFilter(
  input: RenderLlmsTxtInput,
  keep: (p: PageView) => boolean,
): string {
  const header = `# ${input.productName}\n> ${input.productDescription}\n`;
  const pages = loadPages(input.db, input.productId).filter(keep);
  if (pages.length === 0) return header;
  const sections = groupByCategory(pages);
  const body = sections
    .map((sec) => renderSection(sec.category, sec.pages))
    .join("\n");
  return `${header}\n${body}`;
}

function loadPages(db: Sqlite3Database, productId: string): PageView[] {
  const rows = db
    .prepare(
      `SELECT id FROM nodes WHERE kind='doc_page' AND parent_id=? ORDER BY id`,
    )
    .all(productId) as { id: string }[];
  const out: PageView[] = [];
  for (const r of rows) {
    const url = readBestClaim(db, r.id, "url");
    const title = readBestClaim(db, r.id, "title");
    if (url === undefined || title === undefined) continue;
    const category = readBestClaim(db, r.id, "category") ?? DEFAULT_CATEGORY;
    const tierRaw = readBestClaim(db, r.id, "tier");
    const tier: "core" | "optional" = tierRaw === "optional" ? "optional" : "core";
    out.push({ id: r.id, url, title, category, tier });
  }
  return out;
}

interface CategoryGroup {
  readonly category: string;
  readonly pages: PageView[];
}

function groupByCategory(pages: readonly PageView[]): CategoryGroup[] {
  const order: string[] = [];
  const map = new Map<string, PageView[]>();
  for (const p of pages) {
    if (!map.has(p.category)) {
      map.set(p.category, []);
      order.push(p.category);
    }
    map.get(p.category)!.push(p);
  }
  return order.map((category) => ({
    category,
    pages: map.get(category) ?? [],
  }));
}

function renderSection(category: string, pages: readonly PageView[]): string {
  const lines = [`## ${category}`, ""];
  for (const p of pages) {
    lines.push(`- [${p.title}](${p.url})`);
  }
  lines.push("");
  return lines.join("\n");
}

