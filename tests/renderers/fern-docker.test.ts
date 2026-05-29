import { describe, expect, test } from "vitest";
import {
  assertDockerAvailable,
  runFernGenerate,
  DockerUnavailableError,
  type ExecFn,
} from "../../src/renderers/fern-docker.js";
import { FERN_PINS } from "../../src/renderers/fern-images.js";

describe("assertDockerAvailable", () => {
  test("resolves when exec succeeds", async () => {
    await expect(
      assertDockerAvailable(async () => ({ stdout: "ok", stderr: "" })),
    ).resolves.toBeUndefined();
  });

  test("throws DockerUnavailableError with actionable message when exec fails", async () => {
    const failing = async () => {
      throw Object.assign(new Error("spawn docker ENOENT"), {
        code: "ENOENT",
        stderr: "Cannot connect to the Docker daemon",
      });
    };
    await expect(assertDockerAvailable(failing)).rejects.toBeInstanceOf(DockerUnavailableError);
    await expect(assertDockerAvailable(failing)).rejects.toThrow(/skillship sdk warm/);
    await expect(assertDockerAvailable(failing)).rejects.toThrow(/TypeScript SDK was generated normally/);
  });
});

describe("runFernGenerate", () => {
  test("invokes npx fern-api@<pinned> generate --local --group sdks in projectDir", async () => {
    const calls: Array<{
      cmd: string;
      args: readonly string[];
      opts: { cwd?: string; timeout?: number };
    }> = [];
    const exec: ExecFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { stdout: "", stderr: "" };
    };
    await runFernGenerate("/tmp/proj", exec);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("npx");
    expect(calls[0]!.args).toEqual([
      "--yes",
      `fern-api@${FERN_PINS.cliVersion}`,
      "generate",
      "--local",
      "--group",
      "sdks",
    ]);
    expect(calls[0]!.opts.cwd).toBe("/tmp/proj");
  });
});
