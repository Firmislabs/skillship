#!/usr/bin/env node
import { Command } from "commander";
import { join } from "node:path";
import { runInit } from "./init.js";
import { runBuild } from "./build.js";
import { fetchGithubRepoBlobs } from "../resolvers/githubFetcher.js";

function printConfigSummary(
  configPath: string,
  coverage: "bronze" | "silver" | "gold",
  count: number,
): void {
  const msg =
    `skillship init: wrote ${configPath} ` +
    `(${count} sources, coverage=${coverage})`;
  process.stdout.write(`${msg}\n`);
}

function makeProgram(): Command {
  const program = new Command();
  program
    .name("skillship")
    .description("Ingest vendor signals; render agent skills.")
    .version("0.0.0");

  program
    .command("init")
    .description("Discover vendor signals and write .skillship/config.yaml")
    .requiredOption("--domain <url>", "domain or base URL to probe")
    .option("--github <org>", "GitHub org to scan for openapi/cli/mcp/sdk repos")
    .option("--out <dir>", "target directory (defaults to cwd)")
    .option(
      "--timeout-ms <ms>",
      "fetch timeout per probe in milliseconds",
      (v) => Number.parseInt(v, 10),
    )
    .action(async (opts: {
      domain: string;
      github?: string;
      out?: string;
      timeoutMs?: number;
    }) => {
      const r = await runInit({
        domain: opts.domain,
        github: opts.github ?? null,
        githubRepoFetcher: (url) => fetchGithubRepoBlobs(url),
        ...(opts.out !== undefined ? { out: opts.out } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      printConfigSummary(
        r.configPath,
        r.config.coverage,
        r.config.sources.length,
      );
    });

  program
    .command("build")
    .description("Ingest sources into the graph and render skill artifacts")
    .option("--in <dir>", "project directory (defaults to cwd)")
    .option("--out <dir>", "output directory (defaults to <in>/dist)")
    .option("--product-id <id>", "override product node id")
    .action(async (opts: {
      in?: string;
      out?: string;
      productId?: string;
    }) => {
      const inDir = opts.in ?? process.cwd();
      const outDir = opts.out ?? join(inDir, "dist");
      const result = await runBuild({
        in: inDir,
        out: outDir,
        ...(opts.productId !== undefined ? { productId: opts.productId } : {}),
      });
      printBuildSummary(result.artifacts.map((a) => a.path), outDir);
    });

  return program;
}

function printBuildSummary(paths: readonly string[], outDir: string): void {
  process.stdout.write(
    `skillship build: wrote ${paths.length} artifacts to ${outDir}\n`,
  );
  for (const p of paths) process.stdout.write(`  - ${p}\n`);
}

export async function main(argv: readonly string[]): Promise<void> {
  const program = makeProgram();
  await program.parseAsync([...argv]);
}

const entryHref = import.meta.url;
const invokedAs = process.argv[1]
  ? new URL(`file://${process.argv[1]}`).href
  : "";
if (entryHref === invokedAs) {
  main(process.argv).catch((err: unknown) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`skillship: ${message}\n`);
    process.exit(1);
  });
}
