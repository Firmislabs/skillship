// Docker-required. Regenerates the Python/Rust golden trees from the same
// fixtures the TS goldens use, via renderFernSdks.
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildGoldenOas } from "./sdk-golden-helpers.js";
import { renderFernSdks } from "../../src/renderers/sdk-fern.js";
import type { FernLang } from "../../src/renderers/fern-images.js";

export type GoldenFixture = "rest" | "graphql";

/** The committed-tree name for a (lang, fixture) pair. Single source of truth
 *  shared by the regen script + (implicitly) the pure-Node lock's TREES list. */
export function fernTreeName(lang: FernLang, fixture: GoldenFixture): string {
  return fixture === "rest" ? `sdk-${lang}-minimal` : `sdk-${lang}-graphql-minimal`;
}

export async function renderFernGolden(
  fixture: GoldenFixture,
  outParentDir: string,
  langs: readonly FernLang[],
): Promise<void> {
  const args =
    fixture === "rest"
      ? { fixturePath: "tests/fixtures/openapi3/minimal.yaml", contentType: "application/openapi+yaml", productId: "p-min", productName: "min.example" }
      : { fixturePath: "tests/fixtures/graphql/minimal.graphql", contentType: "application/graphql", productId: "p-gql", productName: "gql.example" };
  const { oasJson, productName, overlay } = await buildGoldenOas(args);
  await renderFernSdks({
    oasJson,
    productName,
    outDir: outParentDir,
    overlay,
    langs,
  });
  for (const lang of langs) {
    const generic = join(outParentDir, `sdk-${lang}`);
    const target = join(outParentDir, fernTreeName(lang, fixture));
    rmSync(target, { recursive: true, force: true });
    renameSync(generic, target);
  }
}
