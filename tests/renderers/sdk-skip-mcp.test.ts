// tests/renderers/sdk-skip-mcp.test.ts
// Locks the --skip-mcp behavior at the renderSdkPackage boundary:
//   - skipMcp: true  → tree has NO mcp-*.ts, NO bin/, package.json has no bin
//                      key, README has no "Use with Claude Code" section.
//   - skipMcp omitted → the MCP modules + bin launcher ARE emitted, package.json
//                      carries the bin entry, README carries the section.
// Uses the REST fixture (smallest tree) via the shared golden OAS builder.
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { renderSdkPackage } from "../../src/renderers/sdk.js";
import { buildGoldenOas, REST_FIXTURE_ARGS } from "./sdk-golden-helpers.js";

describe("renderSdkPackage --skip-mcp", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sk-skip-mcp-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test(
    "skipMcp: true emits no MCP modules, no bin/, no bin key, no README section",
    async () => {
      const oas = await buildGoldenOas(REST_FIXTURE_ARGS);
      const outDir = join(tmp, "sdk");
      await renderSdkPackage({
        oasJson: oas.oasJson,
        productName: oas.productName,
        outDir,
        overlay: oas.overlay,
        baseUrl: oas.baseUrl,
        skipMcp: true,
      });
      expect(existsSync(join(outDir, "src/mcp-catalog.ts"))).toBe(false);
      expect(existsSync(join(outDir, "src/mcp-protocol.ts"))).toBe(false);
      expect(existsSync(join(outDir, "src/mcp-server.ts"))).toBe(false);
      expect(existsSync(join(outDir, "bin"))).toBe(false);
      const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
      expect(pkg.bin).toBeUndefined();
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      expect(readme).not.toContain("## Use with Claude Code");
      expect(readme).not.toContain("sdk/bin/mcp.js");
    },
    60000,
  );

  test(
    "default (skipMcp omitted) emits MCP modules, bin launcher, bin key, README section",
    async () => {
      const oas = await buildGoldenOas(REST_FIXTURE_ARGS);
      const outDir = join(tmp, "sdk");
      await renderSdkPackage({
        oasJson: oas.oasJson,
        productName: oas.productName,
        outDir,
        overlay: oas.overlay,
        baseUrl: oas.baseUrl,
      });
      expect(existsSync(join(outDir, "src/mcp-catalog.ts"))).toBe(true);
      expect(existsSync(join(outDir, "src/mcp-protocol.ts"))).toBe(true);
      expect(existsSync(join(outDir, "src/mcp-server.ts"))).toBe(true);
      expect(existsSync(join(outDir, "bin/mcp.js"))).toBe(true);
      expect(existsSync(join(outDir, "bin/loader.mjs"))).toBe(true);
      const pkg = JSON.parse(readFileSync(join(outDir, "package.json"), "utf8"));
      // REST fixture productName is "min.example" → slug "min-example".
      expect(pkg.bin).toEqual({ "min-example-mcp": "bin/mcp.js" });
      const readme = readFileSync(join(outDir, "README.md"), "utf8");
      expect(readme).toContain("## Use with Claude Code");
      expect(readme).toContain('"args": ["sdk/bin/mcp.js"]');
    },
    60000,
  );
});
