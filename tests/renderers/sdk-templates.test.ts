import { describe, expect, test } from "vitest";
import { renderTemplates, type TemplateContext } from "../../src/renderers/sdk-templates/render.js";

describe("renderTemplates", () => {
  const ctx: TemplateContext = {
    productName: "min.example",
    packageName: "@skillship/min-example-sdk",
    year: 2026,
    licenseHolder: "Firmis Labs",
  };

  test("emits five files keyed by their final on-disk names", () => {
    const out = renderTemplates(ctx);
    expect(Object.keys(out).sort()).toEqual([
      ".npmignore",
      "LICENSE",
      "README.md",
      "package.json",
      "tsconfig.json",
    ]);
  });

  test("package.json is valid JSON with strict ESM exports", () => {
    const out = renderTemplates(ctx);
    const pkg = JSON.parse(out["package.json"]!);
    expect(pkg.type).toBe("module");
    expect(pkg.name).toBe("@skillship/min-example-sdk");
    expect(pkg.license).toBe("MIT");
    expect(pkg.main).toBeDefined();
    expect(pkg.types).toBeDefined();
    expect(pkg.exports).toBeDefined();
  });

  test("tsconfig.json is valid JSON with strict: true", () => {
    const out = renderTemplates(ctx);
    const tsc = JSON.parse(out["tsconfig.json"]!);
    expect(tsc.compilerOptions.strict).toBe(true);
    expect(tsc.compilerOptions.module).toMatch(/NodeNext/i);
  });

  test("LICENSE substitutes year and holder", () => {
    const out = renderTemplates(ctx);
    expect(out["LICENSE"]).toContain("2026");
    expect(out["LICENSE"]).toContain("Firmis Labs");
  });

  test("README mentions the product name", () => {
    const out = renderTemplates(ctx);
    expect(out["README.md"]).toContain("min.example");
  });
});
