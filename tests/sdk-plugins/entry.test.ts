import { describe, expect, test } from "vitest";
import { generateEntryModule } from "../../src/sdk-plugins/entry.js";

describe("entry plugin", () => {
  test("entry barrel exports runtime, errors, and resources", () => {
    const code = generateEntryModule();
    expect(code).toContain('export * from "./runtime.js"');
    expect(code).toContain('export * from "./errors.js"');
    expect(code).toContain('export * from "./resources.js"');
  });

  test("entry barrel does NOT export types.gen (avoids ClientOptions collision)", () => {
    const code = generateEntryModule();
    expect(code).not.toContain("types.gen");
  });
});
