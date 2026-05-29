// src/cli/sdk-langs.ts
import type { FernLang } from "../renderers/fern-images.js";

const VALID: readonly FernLang[] = ["python", "rust"];

export function parseFernLangs(raw: string | undefined): FernLang[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: FernLang[] = [];
  for (const part of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (!VALID.includes(part as FernLang)) {
      throw new Error(`invalid --sdk language "${part}"; valid: ${VALID.join(", ")}`);
    }
    if (!out.includes(part as FernLang)) out.push(part as FernLang);
  }
  return out;
}

export function assertSdkFlagsCompatible(
  skipSdk: boolean,
  langs: readonly FernLang[],
): void {
  if (skipSdk && langs.length > 0) {
    throw new Error("--skip-sdk cannot be combined with --sdk");
  }
}
