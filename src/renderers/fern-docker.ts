// src/renderers/fern-docker.ts
// The only side-effectful seam of the Fern path: Docker probe + Fern invocation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FERN_PINS } from "./fern-images.js";

const execFileP = promisify(execFile);

export type ExecFn = (
  cmd: string,
  args: readonly string[],
  opts: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class DockerUnavailableError extends Error {
  constructor(detail: string) {
    super(
      "skillship: --sdk requires Docker, but the Docker daemon isn't reachable " +
        `(${detail}). Start Docker Desktop (or run \`skillship sdk warm\` once ` +
        "online to cache the generator images), then retry. " +
        "TypeScript SDK was generated normally.",
    );
    this.name = "DockerUnavailableError";
  }
}

/** Probes `docker info`; throws DockerUnavailableError if the daemon is unreachable. */
export async function assertDockerAvailable(exec: ExecFn = execFileP): Promise<void> {
  try {
    await exec("docker", ["info"], { timeout: 15000 });
  } catch (err: unknown) {
    const e = err as { code?: string | number; stderr?: string };
    const detail =
      typeof e.stderr === "string" && e.stderr.trim().length > 0
        ? e.stderr.trim().split("\n")[0]!
        : `docker info failed (${String(e.code ?? "unknown")})`;
    throw new DockerUnavailableError(detail);
  }
}

/** Runs `npx --yes fern-api@<pinned> generate --local --group sdks` in projectDir. */
export async function runFernGenerate(
  projectDir: string,
  exec: ExecFn = execFileP,
): Promise<void> {
  await exec(
    "npx",
    ["--yes", `fern-api@${FERN_PINS.cliVersion}`, "generate", "--local", "--group", "sdks"],
    { cwd: projectDir, timeout: 600000 },
  );
}
