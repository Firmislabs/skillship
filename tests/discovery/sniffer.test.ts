import { describe, expect, it } from "vitest";
import { isValidLlmsTxt } from "../../src/discovery/sniffer.js";

describe("isValidLlmsTxt", () => {
  it("accepts text/plain with a hash-prefixed first non-blank line", () => {
    expect(
      isValidLlmsTxt("text/plain", "# My docs\n\nsome content\n"),
    ).toBe(true);
  });

  it("accepts text/markdown with a hash-prefixed first non-blank line", () => {
    expect(
      isValidLlmsTxt("text/markdown; charset=utf-8", "# Title\n"),
    ).toBe(true);
  });

  it("accepts text/plain when blank lines precede the hash line", () => {
    expect(isValidLlmsTxt("text/plain", "\n\n\n# Title\nbody\n")).toBe(
      true,
    );
  });

  it("rejects text/html (Segment/Linear/Amplitude-style served HTML)", () => {
    expect(
      isValidLlmsTxt("text/html; charset=utf-8", "# still a hash-line"),
    ).toBe(false);
  });

  it("rejects text/plain whose first non-blank line is <!DOCTYPE html>", () => {
    expect(
      isValidLlmsTxt(
        "text/plain",
        "<!DOCTYPE html>\n<html>...</html>\n",
      ),
    ).toBe(false);
  });

  it("rejects empty body", () => {
    expect(isValidLlmsTxt("text/plain", "")).toBe(false);
    expect(isValidLlmsTxt("text/plain", "\n\n  \n")).toBe(false);
  });

  it("rejects body whose first non-blank line lacks a leading #", () => {
    expect(
      isValidLlmsTxt("text/plain", "Just some text\nwith no heading\n"),
    ).toBe(false);
  });

  it("is case-insensitive on content-type", () => {
    expect(isValidLlmsTxt("Text/Plain", "# hi")).toBe(true);
    expect(isValidLlmsTxt("TEXT/MARKDOWN", "# hi")).toBe(true);
  });
});
