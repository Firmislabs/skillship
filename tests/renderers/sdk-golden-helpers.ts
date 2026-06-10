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
import { readRestBaseUrl } from "../../src/renderers/claims.js";
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
  /** Base URL read from the ingested REST surface; null when no servers entry. */
  readonly baseUrl: string | null;
}

/** Fixture definitions shared by the TS golden path and the Fern golden path
 *  (single source of truth — both render from byte-identical OAS input). */
export const REST_FIXTURE_ARGS: GoldenOasArgs = {
  fixturePath: "tests/fixtures/openapi3/minimal.yaml",
  contentType: "application/openapi+yaml",
  productId: "p-min",
  productName: "min.example",
};
export const GQL_FIXTURE_ARGS: GoldenOasArgs = {
  fixturePath: "tests/fixtures/graphql/minimal.graphql",
  contentType: "application/graphql",
  productId: "p-gql",
  productName: "gql.example",
};
export const AGENT_FIXTURE_ARGS: GoldenOasArgs = {
  fixturePath: "tests/fixtures/openapi3/agent-minimal.yaml",
  contentType: "application/openapi+yaml",
  productId: "p-agent",
  // Env prefix derives from this: slugify("agentmin").toUpperCase() => "AGENTMIN".
  productName: "agentmin",
};

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
    const overlay = CodegenOverlaySchema.parse({});
    const oasJson = renderSyntheticOpenApi({
      db: graph.db,
      productId: args.productId,
      productName: args.productName,
      overlay,
    });
    const baseUrl = readRestBaseUrl(graph.db, args.productId);
    return { oasJson, productName: args.productName, overlay, baseUrl };
  } finally {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderSdkGoldenRest(outDir: string): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({ ...REST_FIXTURE_ARGS, outDir });
}

export async function renderSdkGoldenGraphql(outDir: string): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({ ...GQL_FIXTURE_ARGS, outDir });
}

export async function renderSdkGoldenAgent(outDir: string): Promise<SdkGoldenResult> {
  return renderSdkGoldenFromFixture({ ...AGENT_FIXTURE_ARGS, outDir });
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
  const { oasJson, productName, overlay, baseUrl } = await buildGoldenOas({
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
    baseUrl,
  });
  return { outDir: args.outDir };
}
