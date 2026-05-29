import { describe, expect, test } from "vitest";
import { parseFernLangs, assertSdkFlagsCompatible } from "../../src/cli/sdk-langs.js";

describe("parseFernLangs", () => {
  test("undefined / empty -> []", () => {
    expect(parseFernLangs(undefined)).toEqual([]);
    expect(parseFernLangs("")).toEqual([]);
    expect(parseFernLangs("  ")).toEqual([]);
  });
  test("parses + lowercases + dedups", () => {
    expect(parseFernLangs("python,rust")).toEqual(["python", "rust"]);
    expect(parseFernLangs("Python,python")).toEqual(["python"]);
  });
  test("throws on unknown lang", () => {
    expect(() => parseFernLangs("go")).toThrow(/invalid --sdk language "go"; valid: python, rust/);
  });
});

describe("assertSdkFlagsCompatible", () => {
  test("throws when --skip-sdk combined with --sdk", () => {
    expect(() => assertSdkFlagsCompatible(true, ["python"])).toThrow(/cannot be combined/);
  });
  test("allows each alone", () => {
    expect(() => assertSdkFlagsCompatible(true, [])).not.toThrow();
    expect(() => assertSdkFlagsCompatible(false, ["python"])).not.toThrow();
  });
});
