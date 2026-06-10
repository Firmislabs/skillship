// src/renderers/sdk-templates/render-usage.ts
// First-request, pagination, and retries section builders extracted from
// render.ts to stay under the 300-line cap.
// Exports: buildFirstRequestSection, buildPaginationSection,
//          buildRetriesSection, formatStatusCodes.
import type { RetriesConfig } from "../../sdk-plugins/runtime.js";
import type { PagesExample, FirstRequestExample } from "./render.js";

// ── First-request section ─────────────────────────────────────────────────────

export function buildFirstRequestSection(
  example: FirstRequestExample | null,
  packageName: string,
): string {
  if (example === null) return "";
  const call = `client.${example.accessor}()`;
  return [
    "## Make a request",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(new Client({ baseUrl: \"https://api.example.com\", auth: { /* ... */ } }));",
    "",
    `const result = await ${call};`,
    "```",
  ].join("\n");
}

// ── Pagination section ────────────────────────────────────────────────────────

export function buildPaginationSection(
  example: PagesExample | null,
  packageName: string,
): string {
  if (example === null) return "";
  // Derive the *Pages method name: "items.list" → "client.items.listPages()"
  const [namespace, methodBase] = example.accessor.split(".");
  const pagesCall = `client.${namespace}.${methodBase}Pages()`;
  const lines = [
    "## Pagination",
    "",
    "Operations with paginated results expose a `*Pages()` async-generator variant",
    "that yields one page of items at a time:",
    "",
    "```ts",
    `import { Client, attachResources } from "${packageName}";`,
    "",
    "const client = attachResources(new Client({ baseUrl: \"https://api.example.com\", auth: { /* ... */ } }));",
    "",
    "// Iterate all pages — the generator fetches the next page on demand.",
    `for await (const page of ${pagesCall}) {`,
    "  console.log(page);",
    "}",
    "```",
  ];
  if (example.pageSizeParam !== null) {
    lines.push("");
    lines.push(`Pass \`{ query: { ${example.pageSizeParam}: N } }\` to control page size.`);
  }
  return lines.join("\n");
}

// ── Retries section ───────────────────────────────────────────────────────────

/**
 * Formats a sorted list of status codes into a compact human-readable string,
 * collapsing consecutive runs into "start–end" ranges (e.g. 502, 503, 504 → "502–504").
 * Exported so unit tests can exercise the formatter directly.
 */
export function formatStatusCodes(codes: readonly number[]): string {
  if (codes.length === 0) return "";
  const sorted = [...codes].sort((a, b) => a - b);
  const groups: Array<[number, number]> = [];
  let start = sorted[0]!;
  let end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const code = sorted[i]!;
    if (code === end + 1) {
      end = code;
    } else {
      groups.push([start, end]);
      start = code;
      end = code;
    }
  }
  groups.push([start, end]);
  return groups.map(([s, e]) => (s === e ? String(s) : `${s}–${e}`)).join(", ");
}

export function buildRetriesSection(retries: RetriesConfig): string {
  const statusList = formatStatusCodes(retries.retryableStatus);
  const statusPhrase =
    statusList.length > 0
      ? ` on retryable status codes (${statusList})`
      : "";
  return [
    "## Retries",
    "",
    `Failed requests are retried automatically (up to ${retries.maxRetries} retries) for`,
    `idempotent methods${statusPhrase}.`,
    "POST/PATCH are retried only on 408 and 429.",
    "The `Retry-After` response header is honored when present.",
  ].join("\n");
}
