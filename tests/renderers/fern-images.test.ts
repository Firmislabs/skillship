import { describe, expect, test } from "vitest";
import { FERN_PINS, pinnedVersion } from "../../src/renderers/fern-images.js";

describe("FERN_PINS", () => {
  test("has python + rust pins with image refs", () => {
    expect(FERN_PINS.generators.python.image).toMatch(/fern-python-sdk/);
    expect(FERN_PINS.generators.rust.image).toMatch(/fern-rust-sdk/);
    expect(FERN_PINS.cliVersion).not.toBe("");
  });
  test("pinnedVersion returns the tag (digest is verification-only; Spike 0.1)", () => {
    // Fern's generators.yml `version:` requires a semver tag — a digest there fails
    // ("Failed to parse version"). digest is recorded for docker-pull + golden verification.
    expect(pinnedVersion({ name: "x", tag: "1.0.0", digest: "sha256:abc", image: "x:1.0.0" }))
      .toBe("1.0.0");
    expect(pinnedVersion({ name: "x", tag: "1.0.0", digest: null, image: "x:1.0.0" }))
      .toBe("1.0.0");
  });
  test("each pin's image equals `${name}:${tag}` (no desync)", () => {
    for (const lang of Object.keys(FERN_PINS.generators) as Array<keyof typeof FERN_PINS.generators>) {
      const pin = FERN_PINS.generators[lang];
      expect(pin.image, `image desync for ${lang}`).toBe(`${pin.name}:${pin.tag}`);
    }
  });
});
