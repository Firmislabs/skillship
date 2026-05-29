// src/renderers/fern-project.ts
// Pure emission of a temp Fern project for the requested languages. Output dirs
// are RELATIVE to the fern/ project root (Fern resolves local-file-system paths
// from there). The caller writes the rewritten OAS to fern/openapi/openapi.json,
// which the required `api:` block in generators.yml points at (Spike 0.1: without
// an `api:` section Fern fails with "Detected empty API definition").
import { stringify as stringifyYaml } from "yaml";
import { FERN_PINS, pinnedVersion, type FernLang } from "./fern-images.js";

export interface FernProjectFiles {
  readonly files: Readonly<Record<string, string>>;
}

interface GeneratorEntry {
  name: string;
  version: string;
  output: { location: string; path: string };
  config?: Record<string, unknown>;
}

export function buildFernProject(langs: readonly FernLang[]): FernProjectFiles {
  if (langs.length === 0) {
    throw new Error("buildFernProject: langs must be non-empty");
  }
  const generators: GeneratorEntry[] = langs.map((lang) => {
    const pin = FERN_PINS.generators[lang];
    const entry: GeneratorEntry = {
      name: pin.name,
      version: pinnedVersion(pin),
      output: { location: "local-file-system", path: `../out/${lang}` },
    };
    const cfg = generatorConfig(lang);
    if (cfg !== undefined) entry.config = cfg;
    return entry;
  });
  const fernConfig = { organization: "skillship", version: FERN_PINS.cliVersion };
  // `api.specs` is REQUIRED — Fern aborts with "Detected empty API definition"
  // otherwise. Path is relative to fern/ (caller writes fern/openapi/openapi.json).
  const generatorsDoc = {
    api: { specs: [{ openapi: "openapi/openapi.json" }] },
    groups: { sdks: { generators } },
  };
  return {
    files: {
      "fern/fern.config.json": JSON.stringify(fernConfig, null, 2) + "\n",
      "fern/generators.yml": stringifyYaml(generatorsDoc),
    },
  };
}

/**
 * Per-language generator config. Python sets `package_name` so docstring example
 * code reads `from skillship_sdk import …` (Spike 0.3 — it does NOT change physical
 * layout; local-file-system mode is always flat). Rust takes no config.
 */
function generatorConfig(lang: FernLang): Record<string, unknown> | undefined {
  if (lang === "python") {
    return { package_name: "skillship_sdk" };
  }
  return undefined;
}
