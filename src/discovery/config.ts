import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { SurfaceKind } from "../graph/types.js";

export type Coverage = "bronze" | "silver" | "gold";

export interface ConfigSourceEntry {
  readonly surface: SurfaceKind;
  readonly url: string;
  readonly sha256: string;
  readonly content_type: string;
  readonly fetched_at: string;
}

export interface SkillshipConfig {
  readonly product: {
    readonly domain: string;
    readonly github_org: string | null;
  };
  readonly sources: readonly ConfigSourceEntry[];
  readonly coverage: Coverage;
}

export function scoreCoverage(count: number): Coverage {
  if (count >= 10) return "gold";
  if (count >= 5) return "silver";
  return "bronze";
}

export interface BuildConfigInput {
  readonly domain: string;
  readonly github_org: string | null;
  readonly sources: readonly ConfigSourceEntry[];
}

export function buildConfig(input: BuildConfigInput): SkillshipConfig {
  return {
    product: {
      domain: input.domain,
      github_org: input.github_org,
    },
    sources: [...input.sources],
    coverage: scoreCoverage(input.sources.length),
  };
}

export function writeConfig(path: string, config: SkillshipConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringifyYaml({
    product: {
      domain: config.product.domain,
      github_org: config.product.github_org,
    },
    sources: config.sources.map((s) => ({
      surface: s.surface,
      url: s.url,
      sha256: s.sha256,
      content_type: s.content_type,
      fetched_at: s.fetched_at,
    })),
    coverage: config.coverage,
  });
  writeFileSync(path, yaml, "utf8");
}
