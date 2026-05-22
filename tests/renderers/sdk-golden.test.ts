import {
  execFileSync,
} from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  renderSdkGoldenRest,
  renderSdkGoldenGraphql,
} from "./sdk-golden-helpers.js";

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const sub of listFilesRecursive(full)) {
        out.push(join(name, sub));
      }
    } else {
      out.push(name);
    }
  }
  return out;
}

function compareTrees(actualDir: string, goldenDir: string): void {
  const actual = listFilesRecursive(actualDir).sort();
  const golden = listFilesRecursive(goldenDir).sort();
  expect(actual, "file lists differ").toEqual(golden);
  for (const rel of actual) {
    const a = readFileSync(join(actualDir, rel), "utf8");
    const g = readFileSync(join(goldenDir, rel), "utf8");
    expect(a, `byte-identity mismatch in ${rel}`).toBe(g);
  }
}

describe("SDK golden lock", () => {
  test(
    "REST golden tree is byte-identical to tests/fixtures/golden/sdk-minimal/",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-gld-rest-"));
      const out = join(tmp, "sdk");
      try {
        await renderSdkGoldenRest(out);
        compareTrees(
          out,
          join(process.cwd(), "tests/fixtures/golden/sdk-minimal"),
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    60000,
  );

  test(
    "GraphQL golden tree is byte-identical to tests/fixtures/golden/sdk-graphql-minimal/",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-gld-gql-"));
      const out = join(tmp, "sdk");
      try {
        await renderSdkGoldenGraphql(out);
        compareTrees(
          out,
          join(process.cwd(), "tests/fixtures/golden/sdk-graphql-minimal"),
        );
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    60000,
  );

  test(
    "REST golden tsconfig.json typechecks against its own sources",
    () => {
      const goldenDir = join(
        process.cwd(),
        "tests/fixtures/golden/sdk-minimal",
      );
      const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
      try {
        execFileSync(tscBin, ["--noEmit", "-p", goldenDir], {
          stdio: "pipe",
        });
      } catch (err: unknown) {
        const e = err as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
          `golden tsc failed:\nstdout:\n${e.stdout?.toString() ?? ""}\nstderr:\n${e.stderr?.toString() ?? ""}`,
        );
      }
    },
    30000,
  );

  test(
    "GraphQL golden tsconfig.json typechecks against its own sources",
    () => {
      const goldenDir = join(
        process.cwd(),
        "tests/fixtures/golden/sdk-graphql-minimal",
      );
      const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
      try {
        execFileSync(tscBin, ["--noEmit", "-p", goldenDir], {
          stdio: "pipe",
        });
      } catch (err: unknown) {
        const e = err as { stdout?: Buffer; stderr?: Buffer };
        throw new Error(
          `golden tsc failed:\nstdout:\n${e.stdout?.toString() ?? ""}\nstderr:\n${e.stderr?.toString() ?? ""}`,
        );
      }
    },
    30000,
  );
});
