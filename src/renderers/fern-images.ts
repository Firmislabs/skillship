// src/renderers/fern-images.ts
// Single source of truth for pinned Fern toolchain versions. Bumping a value
// here is the ONLY sanctioned way Python/Rust SDK output is allowed to change.
export type FernLang = "python" | "rust";

export interface FernGeneratorPin {
  readonly name: string;   // generators.yml name
  readonly tag: string;    // exact published tag — used in generators.yml `version:`
  readonly digest: string | null; // recorded sha256 for docker-pull + golden verification ONLY; NOT usable in generators.yml `version:` (Spike 0.1)
  readonly image: string;  // fully-qualified ref for `docker pull`
}

export interface FernToolchainPins {
  readonly cliVersion: string; // npx fern-api@<version>
  readonly generators: Readonly<Record<FernLang, FernGeneratorPin>>;
}

export const FERN_PINS: FernToolchainPins = {
  cliVersion: "5.40.0",
  generators: {
    python: {
      name: "fernapi/fern-python-sdk",
      tag: "5.14.4",
      digest: "sha256:0daab174eeca54710a75cc35775922d0a51015224159e35cb8d3c69611433084",
      image: "fernapi/fern-python-sdk:5.14.4",
    },
    rust: {
      name: "fernapi/fern-rust-sdk",
      tag: "0.36.8",
      digest: "sha256:04f5adc1cd0faafaa2583cfaaa5af1055f17454907ac387cee6d705659f0c1d6",
      image: "fernapi/fern-rust-sdk:0.36.8",
    },
  },
};

/**
 * Version string for generators.yml `version:` — ALWAYS the tag. Fern rejects a
 * digest here ("Failed to parse version"); the recorded `digest` is for docker-pull
 * + golden verification only (Spike 0.1).
 */
export function pinnedVersion(pin: FernGeneratorPin): string {
  return pin.tag;
}
