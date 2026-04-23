#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./init.js";

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
        ...(opts.out !== undefined ? { out: opts.out } : {}),
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      printConfigSummary(
        r.configPath,
        r.config.coverage,
        r.config.sources.length,
      );
    });

  return program;
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
