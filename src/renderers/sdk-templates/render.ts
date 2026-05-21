// src/renderers/sdk-templates/render.ts
// Loads .tpl files from this directory and substitutes {{PLACEHOLDERS}}.
// Determinism: iteration over a fixed file list in fixed order.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface TemplateContext {
  readonly productName: string;
  readonly packageName: string;
  readonly year: number;
  readonly licenseHolder: string;
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
  };
  const out: Record<string, string> = {};
  for (const spec of TEMPLATES) {
    const raw = readFileSync(join(HERE, spec.tplFile), "utf8");
    out[spec.outName] = applySubs(raw, subs);
  }
  return out;
}

function applySubs(raw: string, subs: Record<string, string>): string {
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (_match, key: string) => {
    const v = subs[key];
    if (v === undefined) throw new Error(`renderTemplates: missing substitution for ${key}`);
    return v;
  });
}
