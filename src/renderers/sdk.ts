// src/renderers/sdk.ts
// pinned: @hey-api/openapi-ts@0.97.2 — see KNOWN_GAPS.md if upgrading
// Emits a TypeScript SDK npm package from a synthetic OpenAPI doc.
// Orchestrates Hey API codegen + 3 wedge plugins + Prettier + tsc gate.
// The wedge plugins are in ../sdk-plugins/{resource-tree,errors,runtime}.ts.
import type { CodegenOverlay } from "../overlays/codegen.js";

export interface RenderSdkInput {
  readonly oasJson: string;
  readonly productName: string;
  /**
   * Fully-resolved final destination for the emitted SDK tree.
   * The renderer does NOT append `/sdk/` or any product slug.
   * The caller pre-resolves (typically `join(skillDir, "sdk")`).
   */
  readonly outDir: string;
  readonly overlay: CodegenOverlay;
  readonly license?: string;
}

export interface SdkRenderResult {
  readonly outDir: string;
  readonly files: readonly string[];
  readonly typecheckExitCode: number;
}

export async function renderSdkPackage(
  input: RenderSdkInput,
): Promise<SdkRenderResult> {
  // Implementation lands in Task 7 (renderer wiring).
  // Skeleton present so plugin tasks can import the types.
  void input;
  throw new Error("renderSdkPackage: not implemented yet (skeleton)");
}
