// src/overlays/codegen.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ResourceRule = z.object({
  namespace: z.string().min(1),
  rename: z.string().min(1).optional(),
});

const PaginationFields = z
  .object({
    requestParam: z.string().optional(),
    pageSizeParam: z.string().optional(),
    itemsField: z.string().optional(),
    nextField: z.string().optional(),
  })
  .strict()
  .default({});

const Pagination = z.object({
  style: z.enum(["cursor", "offset", "page"]),
  fields: PaginationFields,
  perOperation: z.record(z.enum(["cursor", "offset", "page"])).default({}),
});

const Retries = z.object({
  maxRetries: z.number().int().min(0).default(2),
  backoff: z.enum(["exponential-jitter"]).default("exponential-jitter"),
  honorRetryAfter: z.boolean().default(true),
  idempotencyHeader: z.string().default("Idempotency-Key"),
  retryableStatus: z.array(z.number().int()).default([408, 409, 429, 500, 502, 503, 504]),
});

const Auth = z
  .object({
    mode: z.enum(["bearer", "apiKey", "oauth2-client-credentials"]),
    in: z.enum(["header", "query"]).default("header"),
    name: z.string().optional(),
    tokenUrl: z.string().url().optional(),
    valuePrefix: z.string().optional(),
  })
  .refine(
    (a) => a.valuePrefix === undefined || a.mode === "apiKey",
    { message: "valuePrefix is only applicable when mode is 'apiKey'" },
  );

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
  const overlayPath = join(inDir, ".skillship", "overlays", "codegen.yaml");
  if (!existsSync(overlayPath)) return CodegenOverlaySchema.parse({});
  const raw = parseYaml(readFileSync(overlayPath, "utf8")) ?? {};
  const result = CodegenOverlaySchema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0]!;
    throw new Error(
      `codegen overlay invalid at ${first.path.join(".")}: ${first.message}`,
    );
  }
  return result.data;
}

export function applyOverlayToDoc(doc: Record<string, any>, overlay: CodegenOverlay): void {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, any>>;
  for (const pathKey of Object.keys(paths).sort()) {
    const item = paths[pathKey]!;
    for (const method of Object.keys(item).sort()) {
      const op = item[method];
      if (op === null || typeof op !== "object") continue;
      const rule = overlay.resources[op.operationId as string];
      if (rule === undefined) continue;
      if (rule.rename !== undefined) op.operationId = rule.rename;
      op.tags = [rule.namespace];
    }
  }
  doc["x-skillship-codegen"] = {
    pagination: overlay.pagination ?? null,
    retries: overlay.retries ?? null,
    auth: overlay.auth ?? null,
    streaming: [...overlay.streaming].sort(),
    webhooks: overlay.webhooks ?? null,
  };
}
