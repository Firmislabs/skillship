import { describe, expect, test } from "vitest";
import type { RenderSdkInput, SdkRenderResult } from "../../src/renderers/sdk.js";

describe("renderSdkPackage — type surface (skeleton)", () => {
  test("RenderSdkInput type has required fields", () => {
    // Compile-time check via a satisfying value
    const sample: RenderSdkInput = {
      oasJson: "{}",
      productName: "min.example",
      outDir: "/tmp/sdk-out",
      overlay: {
        resources: {},
        streaming: [],
      },
    };
    expect(sample.productName).toBe("min.example");
  });

  test("SdkRenderResult type has expected fields", () => {
    const sample: SdkRenderResult = {
      outDir: "/tmp/sdk-out",
      files: [],
      typecheckExitCode: 0,
    };
    expect(sample.typecheckExitCode).toBe(0);
  });
});
