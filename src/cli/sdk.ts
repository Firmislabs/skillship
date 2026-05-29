// src/cli/sdk.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FERN_PINS, type FernLang } from "../renderers/fern-images.js";

const execFileP = promisify(execFile);

export async function runSdkWarm(): Promise<void> {
  for (const lang of Object.keys(FERN_PINS.generators) as FernLang[]) {
    const pin = FERN_PINS.generators[lang];
    process.stdout.write(`skillship sdk warm: pulling ${pin.image}...\n`);
    await execFileP("docker", ["pull", pin.image], { timeout: 600000 });
  }
  process.stdout.write(`skillship sdk warm: prefetching fern-api@${FERN_PINS.cliVersion}...\n`);
  await execFileP("npx", ["--yes", `fern-api@${FERN_PINS.cliVersion}`, "--version"], {
    timeout: 120000,
  });
  process.stdout.write("skillship sdk warm: offline-ready (images + CLI cached)\n");
}
