// src/renderers/sdk-templates/render.ts
// Loads .tpl files from this directory and substitutes {{PLACEHOLDERS}}.
// Determinism: iteration over a fixed file list in fixed order.
// Auth-section builders live in render-auth.ts; usage/retries builders in render-usage.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuthSchemeDescriptor, RetriesConfig } from "../../sdk-plugins/runtime.js";
import type { PaginationPlan } from "../pagination-detect.js";
import {
  buildEnvTable,
  buildAuthQuickstart,
  buildTokenProviderSection,
} from "./render-auth.js";
import {
  buildFirstRequestSection,
  buildPaginationSection,
  buildRetriesSection,
} from "./render-usage.js";

// Re-export formatStatusCodes so tests that import it from render.js continue to work.
export { formatStatusCodes } from "./render-usage.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface PagesExample {
  /** Accessor path on the client, e.g. "items.list" → used as "client.items.listPages()". */
  readonly accessor: string;
  /** pageSizeParam from the plan, or null when no size param exists. */
  readonly pageSizeParam: string | null;
}

export interface FirstRequestExample {
  /** Accessor path on the client, e.g. "projects.list" → used as "client.projects.list()". */
  readonly accessor: string;
}

export interface TemplateContext {
  readonly productName: string;
  readonly packageName: string;
  readonly year: number;
  readonly licenseHolder: string;
  readonly envPrefix: string;
  readonly schemes: readonly AuthSchemeDescriptor[];
  readonly plans: ReadonlyMap<string, PaginationPlan>;
  /** Per-product retries config — drives both max-retries count and status-code list in the README. */
  readonly retries: RetriesConfig;
  /** Derived from the first plan entry; null when the product has no pagination. */
  readonly pagesExample: PagesExample | null;
  /** Derived from the first non-paginated op; null when there are no ops. */
  readonly firstRequestExample: FirstRequestExample | null;
}

interface TemplateSpec {
  readonly tplFile: string;
  readonly outName: string;
}

const TEMPLATES: readonly TemplateSpec[] = [
  { tplFile: "package.json.tpl", outName: "package.json" },
  { tplFile: "tsconfig.json.tpl", outName: "tsconfig.json" },
  { tplFile: "README.md.tpl", outName: "README.md" },
  { tplFile: "LICENSE.tpl", outName: "LICENSE" },
  { tplFile: "npmignore.tpl", outName: ".npmignore" },
];

export function renderTemplates(
  ctx: TemplateContext,
): Record<string, string> {
  const slug = ctx.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const subs: Record<string, string> = {
    PACKAGE_NAME: ctx.packageName,
    PACKAGE_SLUG: slug,
    PRODUCT_NAME: ctx.productName,
    YEAR: String(ctx.year),
    HOLDER: ctx.licenseHolder,
    README_ENV_TABLE: buildEnvTable(ctx.schemes, ctx.envPrefix),
    README_AUTH_QUICKSTART: buildAuthQuickstart(ctx.schemes, ctx.envPrefix, ctx.packageName),
    README_TOKEN_PROVIDER: buildTokenProviderSection(ctx.packageName),
    README_FIRST_REQUEST: buildFirstRequestSection(ctx.firstRequestExample, ctx.packageName),
    README_PAGINATION: buildPaginationSection(ctx.pagesExample, ctx.packageName),
    README_RETRIES: buildRetriesSection(ctx.retries),
  };
  const out: Record<string, string> = {};
  for (const spec of TEMPLATES) {
    const raw = readFileSync(join(HERE, spec.tplFile), "utf8");
    let rendered = applySubs(raw, subs);
    if (spec.outName === "README.md") {
      // Collapse runs of 3+ newlines (from empty optional sections) to 2.
      rendered = rendered.replace(/\n{3,}/g, "\n\n");
    }
    out[spec.outName] = rendered;
  }
  return out;
}

export function applySubs(raw: string, subs: Record<string, string>): string {
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const v = subs[key];
    if (v === undefined) throw new Error(`renderTemplates: missing substitution for ${key}`);
    return v;
  });
}
