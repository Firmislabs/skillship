import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import { buildFernProject } from "../../src/renderers/fern-project.js";

describe("buildFernProject", () => {
  test("emits fern.config.json + generators.yml for requested langs only", () => {
    const { files } = buildFernProject(["python"]);
    expect(files["fern/fern.config.json"]).toContain('"organization": "skillship"');
    const gen = parseYaml(files["fern/generators.yml"]);
    // api.specs is required — Fern aborts with "empty API definition" without it (Spike 0.1).
    expect(gen.api.specs).toEqual([{ openapi: "openapi/openapi.json" }]);
    const names = gen.groups.sdks.generators.map((g: { name: string }) => g.name);
    expect(names).toEqual(["fernapi/fern-python-sdk"]);
    expect(gen.groups.sdks.generators[0].output.path).toBe("../out/python");
    // Spike 0.3: package_name sets the docstring import root; deterministic.
    expect(gen.groups.sdks.generators[0].config).toEqual({ package_name: "skillship_sdk" });
  });

  test("rust generator carries no python package config", () => {
    const { files } = buildFernProject(["rust"]);
    const gen = parseYaml(files["fern/generators.yml"]);
    expect(gen.groups.sdks.generators[0].config).toBeUndefined();
  });

  test("throws on empty langs", () => {
    expect(() => buildFernProject([])).toThrow(/non-empty/);
  });
});
