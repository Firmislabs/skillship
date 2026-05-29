// tests/renderers/sdk-golden-helpers.ts
// Shared helpers used by BOTH:
//   - tests/renderers/sdk-golden.test.ts (lock assertions)
//   - scripts/gen-sdk-goldens.mts (one-off generator)
//   - tests/renderers/sdk-fern-golden-helpers.ts (Fern golden OAS)
// No vitest imports; pure Node + project imports only.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openGraph } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderSyntheticOpenApi } from "../../src/renderers/oas.js";
import { renderSdkPackage } from "../../src/renderers/sdk.js";
import { CodegenOverlaySchema, type CodegenOverlay } from "../../src/overlays/codegen.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-05-20T12:00:00.000Z";

export interface SdkGoldenResult {
  readonly outDir: string;
}

export interface GoldenOasArgs {
  readonly fixturePath: string;
  readonly contentType: string;
  readonly productId: string;
  readonly productName: string;
}

export interface GoldenOas {
  readonly oasJson: string;
  readonly productName: string;
  readonly overlay: CodegenOverlay;
}

/**
 * Builds the synthetic OAS for a fixture (ingest → renderSyntheticOpenApi), owning
 * the temp-graph lifecycle. Returns the detached oasJson string + the resolved
 * overlay — shared by the TS golden path AND the Fern golden path so both render
 * from byte-identical input.
 */
export async function buildGoldenOas(args: GoldenOasArgs): Promise<GoldenOas> {
  const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-gld-"));
  const graph = openGraph(join(tmp, "g.db"));
  try {
    const bytes = readFileSync(join(process.cwd(), args.fixturePath));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: args.productName, github_org: null },
      sources: [
        {
          surface: "rest",
          url: `https://${args.productName}/spec`,
          sha256: sha,
          content_type: args.contentType,
          fetched_at: NOW,
        },
      ],
      coverage: "bronze",
    };
    await ingestConfig({
      db: graph.db,
      config,
      productId: args.productId,
      loadBytes: async () => bytes,
      now: () => NOW,
    });
    const oasJson = renderSyntheticOpenApi({
      db: graph.db,
      productId: args.productId,
      productName: args.productName,
      overlay: CodegenOverlaySchema.parse({}),
    });
    return { oasJson, productName: args.productName, overlay: CodegenOverlaySchema.parse({}) };
  } finally {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderSdkGoldenRest(
  outDir: string,
): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({
    fixturePath: "tests/fixtures/openapi3/minimal.yaml",
    contentType: "application/openapi+yaml",
    productId: "p-min",
    productName: "min.example",
    outDir,
  });
}

export async function renderSdkGoldenGraphql(
  outDir: string,
): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({
    fixturePath: "tests/fixtures/graphql/minimal.graphql",
    contentType: "application/graphql",
    productId: "p-gql",
    productName: "gql.example",
    outDir,
  });
}

interface FixtureArgs {
  readonly fixturePath: string;
  readonly contentType: string;
  readonly productId: string;
  readonly productName: string;
  readonly outDir: string;
}

async function renderSdkGoldenFromFixture(
  args: FixtureArgs,
): Promise<SdkGoldenResult> {
  const { oasJson, productName, overlay } = await buildGoldenOas({
    fixturePath: args.fixturePath,
    contentType: args.contentType,
    productId: args.productId,
    productName: args.productName,
  });
  await renderSdkPackage({
    oasJson,
    productName,
    outDir: args.outDir,
    overlay,
  });
  return { outDir: args.outDir };
}
