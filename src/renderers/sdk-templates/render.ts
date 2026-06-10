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

/**
 * The single source of truth for the emitted SDK package version. Substituted
 * into package.json.tpl AND handed to the MCP server emitter as its serverVersion
 * (pkgVersion) so the two can never drift. Bump here only.
 */
export const SDK_PACKAGE_VERSION = "0.1.0";

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
  /**
   * True when the SDK package ships the MCP server (the default). Drives the
   * conditional package.json `bin` entry and the README "Use with Claude Code"
   * section. False under --skip-mcp — both render to nothing.
   */
  readonly mcp: boolean;
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
    PACKAGE_VERSION: SDK_PACKAGE_VERSION,
    PACKAGE_BIN: buildPackageBin(ctx.mcp, slug),
    PRODUCT_NAME: ctx.productName,
    YEAR: String(ctx.year),
    HOLDER: ctx.licenseHolder,
    README_ENV_TABLE: buildEnvTable(ctx.schemes, ctx.envPrefix),
    README_AUTH_QUICKSTART: buildAuthQuickstart(ctx.schemes, ctx.envPrefix, ctx.packageName),
    README_TOKEN_PROVIDER: buildTokenProviderSection(ctx.packageName),
    README_FIRST_REQUEST: buildFirstRequestSection(ctx.firstRequestExample, ctx.packageName),
    README_PAGINATION: buildPaginationSection(ctx.pagesExample, ctx.packageName),
    README_RETRIES: buildRetriesSection(ctx.retries),
    README_MCP_SECTION: buildMcpReadmeSection(ctx.mcp, slug),
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

/**
 * Renders the conditional package.json `bin` member. When MCP ships, emits the
 * leading comma + key so the surrounding JSON stays valid; when skipped, emits
 * the empty string (the engines block remains the last member).
 */
function buildPackageBin(mcp: boolean, slug: string): string {
  if (!mcp) return "";
  return `,\n  "bin": {\n    "${slug}-mcp": "bin/mcp.js"\n  }`;
}

/**
 * Renders the conditional README "Use with Claude Code" section: the .mcp.json
 * stdio snippet (relative `node sdk/bin/mcp.js` form), a pointer to the
 * Authentication env table, and the Node >=23.6 requirement note. Empty under
 * --skip-mcp (the surrounding blank lines collapse away in renderTemplates).
 */
function buildMcpReadmeSection(mcp: boolean, slug: string): string {
  if (!mcp) return "";
  return [
    "## Use with Claude Code",
    "",
    "This package ships an MCP server exposing every operation as a tool. Add it",
    "to a `.mcp.json` next to your `sdk/` directory:",
    "",
    "```json",
    "{",
    '  "mcpServers": {',
    `    "${slug}": {`,
    '      "command": "node",',
    '      "args": ["sdk/bin/mcp.js"]',
    "    }",
    "  }",
    "}",
    "```",
    "",
    "Set the auth and base-URL env vars from the [Authentication](#authentication)",
    "table before launching. The server runs the SDK's TypeScript directly, so it",
    "requires **Node >=23.6**.",
  ].join("\n");
}
