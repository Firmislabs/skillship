// tests/renderers/oas-golden.test.ts
// Golden lock test: asserts that renderSyntheticOpenApi output is byte-identical
// to the committed golden files in tests/fixtures/golden/.
// The render helpers are in oas-golden-helpers.ts (no vitest imports) so they
// can be imported by both this test file and the one-off generator script.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { renderRestGolden, renderGraphqlGolden } from "./oas-golden-helpers.js";

test("REST golden: renderSyntheticOpenApi is byte-identical to committed tests/fixtures/golden/oas-minimal.json", async () => {
  const golden = readFileSync(join(process.cwd(), "tests/fixtures/golden/oas-minimal.json"), "utf8");
  expect(await renderRestGolden()).toBe(golden);
});

test("GraphQL golden: renderSyntheticOpenApi is byte-identical to committed tests/fixtures/golden/oas-graphql-minimal.json", async () => {
  const golden = readFileSync(join(process.cwd(), "tests/fixtures/golden/oas-graphql-minimal.json"), "utf8");
  expect(await renderGraphqlGolden()).toBe(golden);
});
