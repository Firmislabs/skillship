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
  test("exact CLI version pin (5.45.3)", () => {
    expect(FERN_PINS.cliVersion).toBe("5.45.3");
  });
  test("exact python tag + digest pin", () => {
    expect(FERN_PINS.generators.python.tag).toBe("5.14.12");
    expect(FERN_PINS.generators.python.digest).toBe(
      "sha256:2a2eb231fcb8726abc42f9a6244b65beb9376a59ad98cc87b5853ec85b5f8a1b",
    );
  });
  test("exact rust tag + digest pin", () => {
    expect(FERN_PINS.generators.rust.tag).toBe("0.40.4");
    expect(FERN_PINS.generators.rust.digest).toBe(
      "sha256:62f87e526256e9378cc844ef9084392235968239d2c6cf5bd6fee59698f3d1bb",
    );
  });
});
