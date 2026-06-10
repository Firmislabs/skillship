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

/**
 * Computed OAuth plan for Fern generators.yml auth-schemes block.
 * Produced ONLY when an oauth2ClientCredentials descriptor exists with a
 * non-null tokenUrl AND the tokenUrl's path matches an OAS path with a POST op
 * AND the token op's requestBody schema has named properties.
 * All property refs carry the $request./$response. prefix required by Fern.
 */
export interface FernOAuthPlan {
  readonly tokenEndpoint: string;
  /** Fern request-properties map: kebab key → "$request.<field>" */
  readonly requestProps: Readonly<Record<string, string>>;
  /** Fern response-properties map: kebab key → "$response.<field>" */
  readonly responseProps: Readonly<Record<string, string>>;
}

export interface BuildFernProjectOpts {
  readonly oauth: FernOAuthPlan | null;
}

interface GeneratorEntry {
  name: string;
  version: string;
  output: { location: string; path: string };
  config?: Record<string, unknown>;
}

export function buildFernProject(
  langs: readonly FernLang[],
  opts: BuildFernProjectOpts,
): FernProjectFiles {
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
  const generatorsDoc = buildGeneratorsDoc(generators, opts.oauth);
  return {
    files: {
      "fern/fern.config.json": JSON.stringify(fernConfig, null, 2) + "\n",
      "fern/generators.yml": stringifyYaml(generatorsDoc),
    },
  };
}

/**
 * Builds the generators.yml document object. When an OAuth plan is provided,
 * emits the S1 auth-schemes block (spike-verified recipe) and sets api.auth.
 * When null, omits both — Fern falls back to its default bearer mapping.
 */
function buildGeneratorsDoc(
  generators: GeneratorEntry[],
  oauth: FernOAuthPlan | null,
): Record<string, unknown> {
  // `api.specs` is REQUIRED — Fern aborts with "Detected empty API definition"
  // otherwise. Path is relative to fern/ (caller writes fern/openapi/openapi.json).
  const api: Record<string, unknown> = {
    specs: [{ openapi: "openapi/openapi.json" }],
  };
  const doc: Record<string, unknown> = { api, groups: { sdks: { generators } } };
  if (oauth === null) return doc;

  doc["auth-schemes"] = buildAuthSchemesBlock(oauth);
  api["auth"] = "OAuth";
  return doc;
}

function buildAuthSchemesBlock(plan: FernOAuthPlan): Record<string, unknown> {
  return {
    OAuth: {
      scheme: "oauth",
      type: "client-credentials",
      "get-token": {
        endpoint: plan.tokenEndpoint,
        "request-properties": { ...plan.requestProps },
        "response-properties": { ...plan.responseProps },
      },
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
