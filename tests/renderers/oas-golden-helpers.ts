// tests/renderers/oas-golden-helpers.ts
// Shared helper functions used by BOTH:
//   - tests/renderers/oas-golden.test.ts (the golden lock assertions)
//   - scripts/gen-goldens.mts (the one-off generator that writes the golden files)
// No vitest imports here — pure Node + project imports only, so the helpers can
// be called from outside the vitest runtime.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openGraph } from "../../src/graph/db.js";
import { ingestConfig } from "../../src/ingest/pipeline.js";
import { renderSyntheticOpenApi } from "../../src/renderers/oas.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import type { SkillshipConfig } from "../../src/discovery/config.js";

const NOW = "2026-05-19T12:00:00.000Z";

export async function renderRestGolden(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "sk-golden-rest-"));
  const graph = openGraph(join(tmp, "g.db"));
  try {
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/openapi3/minimal.yaml"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const config: SkillshipConfig = {
      product: { domain: "min.example", github_org: null },
      sources: [{ surface: "rest", url: "https://min.example/openapi.yaml", sha256: sha, content_type: "application/openapi+yaml", fetched_at: NOW }],
      coverage: "bronze",
    };
    await ingestConfig({ db: graph.db, config, productId: "p-min", loadBytes: async () => bytes, now: () => NOW });
    return renderSyntheticOpenApi({ db: graph.db, productId: "p-min", productName: "min.example", overlay: CodegenOverlaySchema.parse({}) });
  } finally {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function renderGraphqlGolden(): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), "sk-golden-gql-"));
  const graph = openGraph(join(tmp, "g.db"));
  try {
    const bytes = readFileSync(join(process.cwd(), "tests/fixtures/graphql/minimal.graphql"));
    const sha = createHash("sha256").update(bytes).digest("hex");
    // NOTE: surface is "rest" — "graphql" is not a SurfaceKind value.
    // The GraphQL extractor is selected purely by content_type "application/graphql"
    // via src/ingest/dispatch.ts. This is intentional and verified.
    const config: SkillshipConfig = {
      product: { domain: "gql.example", github_org: null },
      sources: [{ surface: "rest", url: "https://gql.example/graphql", sha256: sha, content_type: "application/graphql", fetched_at: NOW }],
      coverage: "bronze",
    };
    await ingestConfig({ db: graph.db, config, productId: "p-gql", loadBytes: async () => bytes, now: () => NOW });
    return renderSyntheticOpenApi({ db: graph.db, productId: "p-gql", productName: "gql.example", overlay: CodegenOverlaySchema.parse({}) });
  } finally {
    graph.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}
