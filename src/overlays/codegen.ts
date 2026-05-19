// src/overlays/codegen.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ResourceRule = z.object({
  namespace: z.string().min(1),
  rename: z.string().min(1).optional(),
});

const Pagination = z.object({
  style: z.enum(["cursor", "offset", "page"]),
  fields: z.record(z.string()).default({}),
  perOperation: z.record(z.enum(["cursor", "offset", "page"])).default({}),
});

const Retries = z.object({
  maxRetries: z.number().int().min(0).default(2),
  backoff: z.enum(["exponential-jitter"]).default("exponential-jitter"),
  honorRetryAfter: z.boolean().default(true),
  idempotencyHeader: z.string().default("Idempotency-Key"),
  retryableStatus: z.array(z.number().int()).default([408, 409, 429, 500, 502, 503, 504]),
});

const Auth = z.object({
  mode: z.enum(["bearer", "apiKey", "oauth2-client-credentials"]),
  in: z.enum(["header", "query"]).default("header"),
  name: z.string().optional(),
});

const Webhooks = z.object({
  scheme: z.enum(["hmac-sha256"]).default("hmac-sha256"),
  signatureHeader: z.string().default("Webhook-Signature"),
});

export const CodegenOverlaySchema = z.object({
  resources: z.record(ResourceRule).default({}),
  pagination: Pagination.optional(),
  retries: Retries.optional(),
  auth: Auth.optional(),
  streaming: z.array(z.string()).default([]),
  webhooks: Webhooks.optional(),
});

export type CodegenOverlay = z.infer<typeof CodegenOverlaySchema>;

export function loadCodegenOverlay(inDir: string): CodegenOverlay {
  const path = join(inDir, ".skillship", "overlays", "codegen.yaml");
  if (!existsSync(path)) return CodegenOverlaySchema.parse({});
  const raw = parseYaml(readFileSync(path, "utf8")) ?? {};
  const result = CodegenOverlaySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new Error(
      `codegen overlay invalid at ${first.path.join(".")}: ${first.message}`,
    );
  }
  return result.data;
}
