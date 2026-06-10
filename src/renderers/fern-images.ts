// src/renderers/fern-images.ts
// Single source of truth for pinned Fern toolchain versions. Bumping a value
// here is the ONLY sanctioned way Python/Rust SDK output is allowed to change.
export type FernLang = "python" | "rust";

export interface FernGeneratorPin {
  readonly name: string;   // generators.yml name
  readonly tag: string;    // exact published tag — used in generators.yml `version:`
  // NEVER use this in generators.yml `version:` — Fern rejects digests there
  // ("Failed to parse version"). Recorded for docker-pull + golden verification (Spike 0.1).
  readonly digest: string | null;
  readonly image: string;  // fully-qualified ref for `docker pull`
}

export interface FernToolchainPins {
  readonly cliVersion: string; // npx fern-api@<version>
  readonly generators: Readonly<Record<FernLang, FernGeneratorPin>>;
}

export const FERN_PINS = {
  cliVersion: "5.45.3",
  generators: {
    python: {
      name: "fernapi/fern-python-sdk",
      tag: "5.14.12",
      // NEVER use this in generators.yml `version:` — Fern rejects digests there
      // ("Failed to parse version"). Recorded for docker-pull + golden verification (Spike 0.1).
      digest: "sha256:2a2eb231fcb8726abc42f9a6244b65beb9376a59ad98cc87b5853ec85b5f8a1b",
      image: "fernapi/fern-python-sdk:5.14.12",
    },
    rust: {
      name: "fernapi/fern-rust-sdk",
      tag: "0.40.4",
      // NEVER use this in generators.yml `version:` — Fern rejects digests there
      // ("Failed to parse version"). Recorded for docker-pull + golden verification (Spike 0.1).
      digest: "sha256:62f87e526256e9378cc844ef9084392235968239d2c6cf5bd6fee59698f3d1bb",
      image: "fernapi/fern-rust-sdk:0.40.4",
    },
  },
} satisfies FernToolchainPins;

/**
 * Version string for generators.yml `version:` — ALWAYS the tag. Fern rejects a
 * digest here ("Failed to parse version"); the recorded `digest` is for docker-pull
 * + golden verification only (Spike 0.1).
 */
export function pinnedVersion(pin: FernGeneratorPin): string {
  return pin.tag;
}
