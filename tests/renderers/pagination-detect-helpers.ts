// tests/renderers/pagination-detect-helpers.ts
// Shared helpers for pagination-detect test split.
// Not a test file (no .test. infix) — importable by both overlay and auto suites.

import type { OperationInfo } from "../../src/sdk-plugins/resource-tree.js";
import { CodegenOverlaySchema } from "../../src/overlays/codegen.js";

// ---- OAS builder helpers ----

export interface OasParam {
  name: string;
  in: string;
  schema?: { type: string };
}

export interface OasResponseSchema {
  type?: string;
  properties?: Record<string, { type: string; items?: unknown }>;
  required?: string[];
}

export function makeGetOas(
  opId: string,
  params: OasParam[],
  responseSchema: OasResponseSchema,
): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: opId,
          tags: ["items"],
          parameters: params,
          responses: {
            "200": {
              content: {
                "application/json": { schema: responseSchema },
              },
            },
          },
        },
      },
    },
  });
}

export function makePostOas(opId: string): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {
      "/token": {
        post: {
          operationId: opId,
          tags: ["auth"],
          parameters: [],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      data: { type: "array", items: {} },
                      next_cursor: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
}

export function makeOp(opId: string, method = "GET", path = "/items"): OperationInfo {
  return { operationId: opId, tags: ["items"], method, path };
}

export const EMPTY_OVERLAY = CodegenOverlaySchema.parse({});

// ---- cursor auto-detect helpers ----

export const CURSOR_SCHEMA: OasResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: {} },
    next_cursor: { type: "string" },
  },
};

export const CURSOR_PARAMS: OasParam[] = [
  { name: "cursor", in: "query", schema: { type: "string" } },
  { name: "limit", in: "query", schema: { type: "integer" } },
];

// ---- offset auto-detect helpers ----

export const OFFSET_SCHEMA: OasResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: {} },
    total: { type: "integer" },
  },
};

export const OFFSET_PARAMS: OasParam[] = [
  { name: "offset", in: "query", schema: { type: "integer" } },
  { name: "limit", in: "query", schema: { type: "integer" } },
];

// ---- page auto-detect helpers ----

export const PAGE_SCHEMA: OasResponseSchema = {
  type: "object",
  properties: {
    data: { type: "array", items: {} },
    total: { type: "integer" },
  },
};

export const PAGE_PARAMS: OasParam[] = [
  { name: "page", in: "query", schema: { type: "integer" } },
  { name: "per_page", in: "query", schema: { type: "integer" } },
];

// ---- envelope response schemas ----
// Envelope: 200-response is an object with EXACTLY ONE object-typed property (the envelope)
// which itself has EXACTLY ONE array property.
// Example: { data: { results: [...], next_cursor: "..." } }

export interface OasEnvelopeSchema {
  type?: string;
  properties?: Record<string, {
    type?: string;
    properties?: Record<string, { type: string; items?: unknown }>;
  }>;
}

export function makeGetOasWithEnvelope(
  opId: string,
  params: OasParam[],
  responseSchema: OasEnvelopeSchema,
): string {
  return JSON.stringify({
    openapi: "3.1.0",
    info: { title: "test", version: "1.0.0" },
    paths: {
      "/items": {
        get: {
          operationId: opId,
          tags: ["items"],
          parameters: params,
          responses: {
            "200": {
              content: {
                "application/json": { schema: responseSchema },
              },
            },
          },
        },
      },
    },
  });
}
