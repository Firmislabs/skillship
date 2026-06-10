#!/usr/bin/env -S node --import tsx/esm
// One-off generator that writes the two SDK golden trees.
// Run: npx tsx scripts/gen-sdk-goldens.mts
// Output: tests/fixtures/golden/sdk-minimal/ and sdk-graphql-minimal/
// Uses the SAME render code path as the golden lock test.
//
// NOTE: The review README (sdk-minimal-README.md) is a SIBLING of the golden
// tree dirs, not inside them. This means it survives the rmSync + atomic-move
// that wipes and rewrites the tree dirs on every regen.
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderSdkGoldenRest,
  renderSdkGoldenGraphql,
  renderSdkGoldenAgent,
} from "../tests/renderers/sdk-golden-helpers.js";
import { parseFernLangs } from "../src/cli/sdk-langs.js";
import {
  renderFernGolden,
  fernTreeName,
  type GoldenFixture,
} from "../tests/renderers/sdk-fern-golden-helpers.js";
import { listEmittedFiles } from "../src/renderers/sdk-fs.js";

async function main(): Promise<void> {
  const repoRoot = process.cwd();
  const restOut = join(repoRoot, "tests/fixtures/golden/sdk-minimal");
  const gqlOut = join(repoRoot, "tests/fixtures/golden/sdk-graphql-minimal");
  const agentOut = join(repoRoot, "tests/fixtures/golden/sdk-agent-minimal");

  rmSync(restOut, { recursive: true, force: true });
  rmSync(gqlOut, { recursive: true, force: true });
  rmSync(agentOut, { recursive: true, force: true });

  await renderSdkGoldenRest(restOut);
  process.stdout.write(`wrote ${restOut}\n`);

  await renderSdkGoldenGraphql(gqlOut);
  process.stdout.write(`wrote ${gqlOut}\n`);

  await renderSdkGoldenAgent(agentOut);
  process.stdout.write(`wrote ${agentOut}\n`);

  const langs = parseFernLangs(
    process.argv.find((a) => a.startsWith("--langs="))?.slice("--langs=".length)
      ?? (process.argv.includes("--langs") ? process.argv[process.argv.indexOf("--langs") + 1] : undefined),
  );
  const parent = join(repoRoot, "tests/fixtures/golden");
  for (const fixture of ["rest", "graphql", "agent"] as const satisfies readonly GoldenFixture[]) {
    if (langs.length === 0) break;
    await renderFernGolden(fixture, parent, langs);
    for (const lang of langs) {
      const dir = join(parent, fernTreeName(lang, fixture));
      const manifest: Record<string, string> = {};
      for (const rel of listEmittedFiles(dir)) {
        manifest[rel] = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
      }
      writeFileSync(`${dir}.manifest.json`, JSON.stringify(manifest, null, 2) + "\n", "utf8");
      process.stdout.write(`wrote ${dir} (+ manifest)\n`);
    }
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`gen-sdk-goldens: ${msg}\n`);
  process.exit(1);
});
