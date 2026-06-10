// tests/sdk-plugins/mcp-launcher.test.ts
// Unit-locks the two launcher emitters:
//   generateMcpLoaderModule  — byte-verbatim 17-line resolve hook (.js→.ts).
//   generateMcpLauncherModule — bin/mcp.js: shebang, Node>=23.6 gate, register,
//                               dynamic import of ../src/mcp-server.ts, main().
import { describe, expect, test } from "vitest";
import {
  generateMcpLoaderModule,
  generateMcpLauncherModule,
} from "../../src/sdk-plugins/mcp-launcher.js";

describe("generateMcpLoaderModule", () => {
  test("is the byte-verbatim spike resolve hook", () => {
    const expected = `import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".js")) {
    return nextResolve(specifier, context);
  }
  const resolved = new URL(specifier, context.parentURL ?? import.meta.url);
  const jsPath = fileURLToPath(resolved);
  if (!existsSync(jsPath)) {
    const tsPath = jsPath.replace(/\\.js$/, ".ts");
    if (existsSync(tsPath)) {
      return nextResolve(specifier.replace(/\\.js$/, ".ts"), context);
    }
  }
  return nextResolve(specifier, context);
}
`;
    expect(generateMcpLoaderModule()).toBe(expected);
  });
});

describe("generateMcpLauncherModule", () => {
  const src = generateMcpLauncherModule();

  test("starts with the node shebang", () => {
    expect(src.startsWith("#!/usr/bin/env node\n")).toBe(true);
  });

  test("gates on Node major/minor >= 23.6 and exits 1 below floor", () => {
    expect(src).toContain("process.versions.node.split");
    expect(src).toContain("major < 23 || (major === 23 && minor < 6)");
    expect(src).toContain("process.exit(1)");
  });

  test("registers the loader hook before importing", () => {
    expect(src).toContain('import { register } from "node:module";');
    expect(src).toContain('register("./loader.mjs", import.meta.url)');
  });

  test("dynamically imports the TS entry and calls main()", () => {
    expect(src).toContain(
      'await import(new URL("../src/mcp-server.ts", import.meta.url).href)',
    );
    expect(src).toContain("mod.main();");
  });

  test("ends with a trailing newline", () => {
    expect(src.endsWith("\n")).toBe(true);
  });
});
