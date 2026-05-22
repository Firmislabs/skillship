#!/usr/bin/env -S node --import tsx/esm
// One-off generator that writes the two SDK golden trees.
// Run: npx tsx scripts/gen-sdk-goldens.mts
// Output: tests/fixtures/golden/sdk-minimal/ and sdk-graphql-minimal/
// Uses the SAME render code path as the golden lock test.
//
// NOTE: The review README (sdk-minimal-README.md) is a SIBLING of the golden
// tree dirs, not inside them. This means it survives the rmSync + atomic-move
// that wipes and rewrites the tree dirs on every regen.
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  renderSdkGoldenRest,
  renderSdkGoldenGraphql,
} from "../tests/renderers/sdk-golden-helpers.js";

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const restOut = join(repoRoot, "tests/fixtures/golden/sdk-minimal");
  const gqlOut = join(repoRoot, "tests/fixtures/golden/sdk-graphql-minimal");

  rmSync(restOut, { recursive: true, force: true });
  rmSync(gqlOut, { recursive: true, force: true });

  await renderSdkGoldenRest(restOut);
  process.stdout.write(`wrote ${restOut}\n`);

  await renderSdkGoldenGraphql(gqlOut);
  process.stdout.write(`wrote ${gqlOut}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`gen-sdk-goldens: ${msg}\n`);
  process.exit(1);
});
