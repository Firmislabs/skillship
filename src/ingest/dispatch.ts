import type { SourceNode } from "../graph/types.js";
import type { Extraction } from "../extractors/types.js";
import { extractOpenApi3 } from "../extractors/openapi3.js";
import { extractSwagger2 } from "../extractors/swagger2.js";
import { extractOpenrefCli } from "../extractors/openrefCli.js";
import { extractOpenrefSdk } from "../extractors/openrefSdk.js";
import { extractSitemap } from "../extractors/sitemap.js";
import { extractLlmsTxt } from "../extractors/llmsTxt.js";
import { extractMcpWellKnown } from "../extractors/mcpWellKnown.js";
import { extractZodAst } from "../extractors/zodAst.js";
import { extractDocsMd } from "../extractors/docsMd.js";
import { extractGraphql } from "../extractors/graphql.js";
import { GITHUB_REPO_PLACEHOLDER } from "../resolvers/githubSpecs.js";

export interface DispatchInput {
  readonly bytes: Buffer;
  readonly source: SourceNode;
  readonly productId: string;
}

type ExtractorFn = (input: DispatchInput) => Promise<Extraction> | Extraction;

const CONTENT_TYPE_DISPATCH: Record<string, ExtractorFn> = {
  "application/openapi+yaml": extractOpenApi3,
  "application/openapi+json": extractOpenApi3,
  "application/swagger+yaml": extractSwagger2,
  "application/swagger+json": extractSwagger2,
  "application/x-openref-cli+yaml": extractOpenrefCli,
  "application/x-openref-sdk+yaml": extractOpenrefSdk,
  "application/typescript": extractZodAst,
  "application/graphql": extractGraphql,
};

export async function dispatchExtractor(
  input: DispatchInput,
): Promise<Extraction | null> {
  const head = headContentType(input.source.content_type);
  if (head === GITHUB_REPO_PLACEHOLDER) return null;
  const direct = CONTENT_TYPE_DISPATCH[head];
  if (direct !== undefined) return direct(input);
  if (head === "application/xml" || head === "text/xml") {
    return extractSitemap(input);
  }
  if (head === "application/json" && isWellKnownUrl(input.source.url)) {
    return extractMcpWellKnown(input);
  }
  if (head === "text/plain" && isLlmsTxtUrl(input.source.url)) {
    return extractLlmsTxt(input);
  }
  if (head === "text/markdown" || head === "text/plain") {
    return extractDocsMd(input);
  }
  return null;
}

function headContentType(raw: string): string {
  return raw.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function isWellKnownUrl(url: string): boolean {
  try {
    return new URL(url).pathname.includes("/.well-known/");
  } catch {
    return false;
  }
}

function isLlmsTxtUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith("/llms.txt") || path === "/llms.txt";
  } catch {
    return false;
  }
}
