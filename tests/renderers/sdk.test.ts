import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";
import { renderSdkPackage } from "../../src/renderers/sdk.js";
import type { RenderSdkInput, SdkRenderResult } from "../../src/renderers/sdk.js";

describe("renderSdkPackage — type surface (skeleton)", () => {
  test("RenderSdkInput type has required fields", () => {
    // Compile-time check via a satisfying value
    const sample: RenderSdkInput = {
      oasJson: "{}",
      productName: "min.example",
      outDir: "/tmp/sdk-out",
      overlay: {
        resources: {},
        streaming: [],
      },
    };
    expect(sample.productName).toBe("min.example");
  });

  test("SdkRenderResult type has expected fields", () => {
    const sample: SdkRenderResult = {
      outDir: "/tmp/sdk-out",
      files: [],
      typecheckExitCode: 0,
    };
    expect(sample.typecheckExitCode).toBe(0);
  });
});

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const sub of listFilesRecursive(full)) out.push(join(name, sub));
    } else {
      out.push(name);
    }
  }
  return out;
}

const MINIMAL_OAS = JSON.stringify(
  {
    openapi: "3.1.0",
    info: { title: "min.example", version: "1.0.0" },
    paths: {
      "/projects": {
        get: {
          operationId: "listProjects",
          responses: {
            "200": {
              description: "OK",
              content: {
                "application/json": { schema: { type: "object" } },
              },
            },
          },
          security: [{ bearer_main: [] }],
          tags: ["projects"],
        },
      },
    },
    components: {
      schemas: {},
      securitySchemes: { bearer_main: { type: "http", scheme: "bearer" } },
    },
  },
  null,
  2,
);

describe("renderSdkPackage — integration", () => {
  test(
    "emits a package tree with package.json, tsconfig.json, src/, and a 0 typecheck exit",
    async () => {
      const tmpA = mkdtempSync(join(tmpdir(), "sk-sdk-A-"));
      try {
        const result = await renderSdkPackage({
          oasJson: MINIMAL_OAS,
          productName: "min.example",
          outDir: tmpA,
          overlay: CodegenOverlaySchema.parse({}),
        });
        expect(result.typecheckExitCode).toBe(0);
        const files = listFilesRecursive(tmpA).sort();
        expect(files).toContain("package.json");
        expect(files).toContain("tsconfig.json");
        expect(files).toContain("README.md");
        expect(files).toContain("LICENSE");
        expect(files).toContain(".npmignore");
        expect(
          files.some(f => f.startsWith("src") && f.endsWith("errors.ts")),
        ).toBe(true);
        expect(
          files.some(f => f.startsWith("src") && f.endsWith("runtime.ts")),
        ).toBe(true);
        expect(
          files.some(f => f.startsWith("src") && f.endsWith("resources.ts")),
        ).toBe(true);
      } finally {
        rmSync(tmpA, { recursive: true, force: true });
      }
    },
    60000,
  );

  test(
    "two consecutive renders produce byte-identical trees",
    async () => {
      const tmpA = mkdtempSync(join(tmpdir(), "sk-sdk-det-A-"));
      const tmpB = mkdtempSync(join(tmpdir(), "sk-sdk-det-B-"));
      try {
        await renderSdkPackage({
          oasJson: MINIMAL_OAS,
          productName: "min.example",
          outDir: tmpA,
          overlay: CodegenOverlaySchema.parse({}),
        });
        await renderSdkPackage({
          oasJson: MINIMAL_OAS,
          productName: "min.example",
          outDir: tmpB,
          overlay: CodegenOverlaySchema.parse({}),
        });
        const filesA = listFilesRecursive(tmpA).sort();
        const filesB = listFilesRecursive(tmpB).sort();
        expect(filesB).toEqual(filesA);
        for (const f of filesA) {
          expect(
            readFileSync(join(tmpB, f), "utf8"),
            `mismatch in ${f}`,
          ).toBe(readFileSync(join(tmpA, f), "utf8"));
        }
      } finally {
        rmSync(tmpA, { recursive: true, force: true });
        rmSync(tmpB, { recursive: true, force: true });
      }
    },
    120000,
  );

  test(
    "emitted package tree does not contain openapi.json",
    async () => {
      const tmpA = mkdtempSync(join(tmpdir(), "sk-sdk-nooas-"));
      try {
        const result = await renderSdkPackage({
          oasJson: MINIMAL_OAS,
          productName: "min.example",
          outDir: tmpA,
          overlay: CodegenOverlaySchema.parse({}),
        });
        expect(result.files).not.toContain("openapi.json");
        const allFiles = listFilesRecursive(tmpA);
        expect(allFiles).not.toContain("openapi.json");
      } finally {
        rmSync(tmpA, { recursive: true, force: true });
      }
    },
    60000,
  );

  test(
    "throws with a clear error on unsupported security scheme (oauth2)",
    async () => {
      const oasWithOauth2 = JSON.stringify({
        openapi: "3.1.0",
        info: { title: "oauth-test", version: "1.0.0" },
        paths: {},
        components: {
          schemas: {},
          securitySchemes: {
            myOauth: {
              type: "oauth2",
              flows: { clientCredentials: { tokenUrl: "https://example.com/token", scopes: {} } },
            },
          },
        },
      });
      await expect(
        renderSdkPackage({
          oasJson: oasWithOauth2,
          productName: "oauth-test",
          outDir: join(tmpdir(), "sk-sdk-oauth2-test"),
          overlay: CodegenOverlaySchema.parse({}),
        }),
      ).rejects.toThrow(/unsupported security scheme/);
    },
    30000,
  );

  test(
    "throws when productName slugifies to empty",
    async () => {
      await expect(
        renderSdkPackage({
          oasJson: MINIMAL_OAS,
          productName: "!!!",
          outDir: join(tmpdir(), "sk-sdk-slug-test"),
          overlay: CodegenOverlaySchema.parse({}),
        }),
      ).rejects.toThrow(/slugifies to empty/);
    },
    30000,
  );

  test(
    "leaves outDir untouched on typecheck failure WITH pre-existing sentinel file",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-sentinel-"));
      const outDir = join(tmp, "sdk");
      // Pre-create outDir with a sentinel file
      const { mkdirSync } = await import("node:fs");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "sentinel.txt"), "DO NOT DELETE", "utf8");
      const brokenOas = JSON.stringify(
        {
          openapi: "3.1.0",
          info: { title: "broken", version: "1.0.0" },
          paths: {
            "/x": {
              get: {
                operationId: "x",
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/Missing" },
                      },
                    },
                  },
                },
              },
            },
          },
          components: { schemas: {}, securitySchemes: {} },
        },
        null,
        2,
      );
      try {
        await expect(
          renderSdkPackage({
            oasJson: brokenOas,
            productName: "broken",
            outDir,
            overlay: CodegenOverlaySchema.parse({}),
          }),
        ).rejects.toThrow();
        // Sentinel must survive
        expect(readFileSync(join(outDir, "sentinel.txt"), "utf8")).toBe("DO NOT DELETE");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    60000,
  );

  test(
    "leaves outDir untouched on typecheck failure (atomic guarantee)",
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), "sk-sdk-fail-"));
      const outDir = join(tmp, "sdk");
      const brokenOas = JSON.stringify(
        {
          openapi: "3.1.0",
          info: { title: "broken", version: "1.0.0" },
          paths: {
            "/x": {
              get: {
                operationId: "x",
                responses: {
                  "200": {
                    description: "OK",
                    content: {
                      "application/json": {
                        schema: { $ref: "#/components/schemas/Missing" },
                      },
                    },
                  },
                },
              },
            },
          },
          components: { schemas: {}, securitySchemes: {} },
        },
        null,
        2,
      );
      try {
        await expect(
          renderSdkPackage({
            oasJson: brokenOas,
            productName: "broken",
            outDir,
            overlay: CodegenOverlaySchema.parse({}),
          }),
        ).rejects.toThrow();
        expect(() => statSync(outDir)).toThrow();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    60000,
  );
});
