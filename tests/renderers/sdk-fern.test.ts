import { describe, expect, test } from "vitest";
import { renderFernSdks } from "../../src/renderers/sdk-fern.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

describe("renderFernSdks", () => {
  test("empty langs short-circuits with no emission and no Docker call", async () => {
    const result = await renderFernSdks({
      oasJson: JSON.stringify({ openapi: "3.1.0", paths: {} }),
      productName: "x",
      outDir: "/tmp/should-not-be-written",
      overlay: CodegenOverlaySchema.parse({}),
      langs: [],
    });
    expect(result.emitted).toEqual([]);
  });
});
