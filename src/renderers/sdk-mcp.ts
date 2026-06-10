// src/renderers/sdk-mcp.ts
// MCP emission for the SDK package, factored out of sdk.ts to keep that file
// under the 300-line house rule. Writes the three generated MCP modules into
// src/ and the two launcher files into bin/:
//   src/mcp-catalog.ts   — data-only operation index (computeCatalogEntries).
//   src/mcp-protocol.ts  — stdio JSON-RPC transport + protocol handler.
//   src/mcp-server.ts     — the gateway (search/describe/invoke + main()).
//   bin/mcp.js            — Node >=23.6 launcher (registers loader, calls main).
//   bin/loader.mjs        — the .js→.ts resolve hook (byte-verbatim spike text).
//
// The .ts modules join the wedge prettier/tsc pass (sdk.ts walks every .ts under
// the temp tree); the bin/ files are NOT TypeScript and are written verbatim.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeCatalogEntries,
  generateMcpCatalogModule,
} from "../sdk-plugins/mcp-catalog.js";
import { generateMcpProtocolModule } from "../sdk-plugins/mcp-protocol.js";
import { generateMcpServerModule } from "../sdk-plugins/mcp-server.js";
import {
  generateMcpLoaderModule,
  generateMcpLauncherModule,
} from "../sdk-plugins/mcp-launcher.js";
import { collectEnvVarNames } from "../sdk-plugins/auth-emit.js";
import { SDK_PACKAGE_VERSION } from "./sdk-templates/render.js";
import type { WedgeInputs } from "./sdk-utils.js";

/**
 * Emits the MCP server modules + launcher into the temp SDK tree. Pure I/O over
 * the already-computed wedge inputs; catalog is computed here beside the wedge
 * (it needs ops/oasJson/overlay — all on the wedge). The MCP module's auth
 * env-var names are derived from the SAME collectEnvVarNames the SDK's
 * REQUIRED_ENV_VARS uses, so describe_operation's auth line cannot drift.
 */
export function writeMcpModules(
  tempDir: string,
  oasJson: string,
  productName: string,
  wedge: WedgeInputs,
): void {
  const srcDir = join(tempDir, "src");
  mkdirSync(srcDir, { recursive: true });
  const entries = computeCatalogEntries(wedge.ops, oasJson, wedge.overlay);
  writeFileSync(
    join(srcDir, "mcp-catalog.ts"),
    generateMcpCatalogModule(entries),
    "utf8",
  );
  writeFileSync(
    join(srcDir, "mcp-protocol.ts"),
    generateMcpProtocolModule(),
    "utf8",
  );
  const authEnvVars = collectEnvVarNames(wedge.schemes, wedge.envPrefix);
  writeFileSync(
    join(srcDir, "mcp-server.ts"),
    generateMcpServerModule({
      productName,
      envPrefix: wedge.envPrefix,
      baseUrl: wedge.baseUrl,
      pkgVersion: SDK_PACKAGE_VERSION,
      authEnvVars,
    }),
    "utf8",
  );
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "mcp.js"), generateMcpLauncherModule(), "utf8");
  writeFileSync(
    join(binDir, "loader.mjs"),
    generateMcpLoaderModule(),
    "utf8",
  );
}
