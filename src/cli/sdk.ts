// src/cli/sdk.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FERN_PINS, type FernLang } from "../renderers/fern-images.js";

const execFileP = promisify(execFile);

/** First line of an unknown error, for compact CLI diagnostics. */
function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
}

export async function runSdkWarm(): Promise<void> {
  for (const lang of Object.keys(FERN_PINS.generators) as FernLang[]) {
    const pin = FERN_PINS.generators[lang];
    process.stdout.write(`skillship sdk warm: pulling ${pin.image}...\n`);
    try {
      await execFileP("docker", ["pull", pin.image], { timeout: 600000 });
    } catch (err: unknown) {
      throw new Error(
        `skillship sdk warm: \`docker pull ${pin.image}\` failed (${firstLine(err)}). ` +
          "Is the Docker daemon running? Start Docker Desktop and retry.",
      );
    }
  }
  process.stdout.write(`skillship sdk warm: prefetching fern-api@${FERN_PINS.cliVersion}...\n`);
  try {
    await execFileP("npx", ["--yes", `fern-api@${FERN_PINS.cliVersion}`, "--version"], {
      timeout: 120000,
    });
  } catch (err: unknown) {
    throw new Error(
      `skillship sdk warm: prefetching fern-api@${FERN_PINS.cliVersion} failed ` +
        `(${firstLine(err)}). Check your network/npm access and retry.`,
    );
  }
  process.stdout.write("skillship sdk warm: offline-ready (images + CLI cached)\n");
}
