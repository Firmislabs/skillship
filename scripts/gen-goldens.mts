#!/usr/bin/env -S node --import tsx/esm
// One-off generator that writes the two R-OAS golden files.
// Uses the SAME render code path as the golden lock test — see
// tests/renderers/oas-golden-helpers.ts. The byte-identity discipline
// established in Plan 1 Task 7 depends on this shared module.
//
// Run with: npx tsx scripts/gen-goldens.mts
// (tsx is invoked via the shebang above when executed directly.)

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderRestGolden,
  renderGraphqlGolden,
} from "../tests/renderers/oas-golden-helpers.js";

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const restPath = join(repoRoot, "tests/fixtures/golden/oas-minimal.json");
  const gqlPath = join(
    repoRoot,
    "tests/fixtures/golden/oas-graphql-minimal.json"
  );

  const rest = await renderRestGolden();
  writeFileSync(restPath, rest, "utf8");
  process.stdout.write(
    `wrote ${restPath} (${Buffer.byteLength(rest, "utf8")} bytes)\n`
  );

  const gql = await renderGraphqlGolden();
  writeFileSync(gqlPath, gql, "utf8");
  process.stdout.write(
    `wrote ${gqlPath} (${Buffer.byteLength(gql, "utf8")} bytes)\n`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`gen-goldens: ${msg}\n`);
  process.exit(1);
});
