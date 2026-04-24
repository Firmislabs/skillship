#!/usr/bin/env node
// Harness: runs build + scorers per vendor, writes a JSON report.
// Vendors without a prepared eval/projects/<id>/.skillship dir are
// skipped-with-reason, not errored, so the harness never blocks on a
// partial seed.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import Database from "better-sqlite3";
import { runBuild } from "../src/cli/build.js";
import {
  scoreCoverage,
  scoreFormat,
  scoreGrounding,
  type CoverageReport,
  type ExpectedOp,
  type FormatReport,
  type GroundingReport,
} from "./scorers.js";
import {
  scoreQualitative,
  type QualitativeReport,
} from "./qualitative.js";

interface VendorSpec {
  readonly id: string;
  readonly domain: string;
  readonly github_org?: string | null;
  readonly expected: {
    readonly surfaces: string[];
    readonly ops_min: number;
    readonly baseline_path: string | null;
  };
}

interface VendorsFile {
  readonly vendors: VendorSpec[];
}

interface TaskEntry {
  readonly id: string;
  readonly goal: string;
  readonly expected_ops: ExpectedOp[];
}

interface TasksFile {
  readonly vendor: string;
  readonly tasks: TaskEntry[];
}

interface VendorReport {
  readonly vendor: string;
  readonly status: "ok" | "skipped";
  readonly reason?: string;
  readonly coverage?: CoverageReport;
  readonly grounding?: GroundingReport;
  readonly format?: FormatReport;
  readonly opCountMin?: { required: number; observed: number; ok: boolean };
  readonly qualitative?: QualitativeReport;
}

interface HarnessReport {
  readonly generated_at: string;
  readonly vendors: VendorReport[];
}

const ROOT = process.cwd();
const EVAL_DIR = join(ROOT, "eval");
const PROJECTS_DIR = join(EVAL_DIR, "projects");
const OUT_DIR = join(EVAL_DIR, "out");
const GROUNDING_SAMPLE = 100;

async function main(): Promise<void> {
  const vendorsFile = parseYaml(
    readFileSync(join(EVAL_DIR, "vendors.yaml"), "utf8"),
  ) as VendorsFile;
  mkdirSync(OUT_DIR, { recursive: true });
  const reports: VendorReport[] = [];
  for (const v of vendorsFile.vendors) {
    reports.push(await scoreVendor(v));
  }
  const report: HarnessReport = {
    generated_at: new Date().toISOString(),
    vendors: reports,
  };
  const outPath = join(OUT_DIR, "report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  printSummary(report, outPath);
}

async function scoreVendor(v: VendorSpec): Promise<VendorReport> {
  const projectDir = join(PROJECTS_DIR, v.id);
  const skDir = join(projectDir, ".skillship");
  if (!existsSync(join(skDir, "config.yaml"))) {
    return {
      vendor: v.id,
      status: "skipped",
      reason: `missing ${skDir}/config.yaml — run \`skillship init --domain ${v.domain} --out ${projectDir}\` first`,
    };
  }
  const tasksPath = join(EVAL_DIR, "tasks", `${v.id}.yaml`);
  const tasks = existsSync(tasksPath)
    ? (parseYaml(readFileSync(tasksPath, "utf8")) as TasksFile).tasks
    : [];
  const expected = tasks.flatMap((t) => t.expected_ops);
  const distDir = join(projectDir, "dist");
  const build = await runBuild({ in: projectDir, out: distDir });
  const db = new Database(join(skDir, "graph.sqlite"));
  try {
    const coverage = scoreCoverage(db, build.productId, expected);
    const grounding = scoreGrounding(
      db,
      join(skDir, "sources"),
      GROUNDING_SAMPLE,
    );
    const skillDir = resolveSkillDir(distDir);
    const format = scoreFormat(skillDir);
    const qualitative = computeQualitative(
      db,
      build.productId,
      skillDir,
      expected,
    );
    return {
      vendor: v.id,
      status: "ok",
      coverage,
      grounding,
      format,
      opCountMin: {
        required: v.expected.ops_min,
        observed: build.ingest.operations,
        ok: build.ingest.operations >= v.expected.ops_min,
      },
      qualitative,
    };
  } finally {
    db.close();
  }
}

function computeQualitative(
  db: Database.Database,
  productId: string,
  skillDir: string,
  expected: ExpectedOp[],
): QualitativeReport {
  const skillMdPath = join(skillDir, "SKILL.md");
  const skillMd = existsSync(skillMdPath)
    ? readFileSync(skillMdPath, "utf8")
    : "";
  const skillMdBytes = Buffer.byteLength(skillMd, "utf8");
  return scoreQualitative(db, productId, skillMd, skillMdBytes, expected, undefined, skillDir);
}

function printSummary(report: HarnessReport, outPath: string): void {
  process.stdout.write(`eval: wrote ${outPath}\n`);
  for (const r of report.vendors) {
    if (r.status === "skipped") {
      process.stdout.write(`  [skip] ${r.vendor}: ${r.reason}\n`);
      continue;
    }
    const cov = r.coverage ? pct(r.coverage.hitRate) : "—";
    const grd = r.grounding ? pct(r.grounding.hitRate) : "—";
    const fmt = r.format?.ok ? "pass" : "fail";
    const ops = r.opCountMin
      ? `${r.opCountMin.observed}/${r.opCountMin.required}`
      : "—";
    const q = r.qualitative;
    const qStr = q
      ? ` | qual=${pct(q.composite)} str=${pct(q.structure)} den=${pct(q.density)} frsh=${pct(q.freshness)} sch=${pct(q.schemaFidelity)} qcov=${pct(q.coverage)}`
      : "";
    process.stdout.write(
      `  [ok]   ${r.vendor}: cov=${cov} grd=${grd} fmt=${fmt} ops=${ops}${qStr}\n`,
    );
  }
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function resolveSkillDir(distDir: string): string {
  if (!existsSync(distDir)) return join(distDir, "missing");
  const dirs = readdirSync(distDir);
  const first = dirs[0];
  return first !== undefined
    ? join(distDir, first)
    : join(distDir, "missing");
}

const entryHref = import.meta.url;
const invokedAs = process.argv[1]
  ? new URL(`file://${process.argv[1]}`).href
  : "";
if (entryHref === invokedAs) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`eval: ${msg}\n`);
    process.exit(1);
  });
}
