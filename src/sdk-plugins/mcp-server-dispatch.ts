// src/sdk-plugins/mcp-server-dispatch.ts
// Line-array builders for the EMITTED callTool dispatch: tool definitions
// (tools/list) plus the search / describe / invoke handlers. Split out of
// mcp-server-emit.ts so both emitter files stay under the 300-line house rule
// (auth/auth-emit precedent).
//
// Every export returns an EMITTED TypeScript string; nothing here runs at MCP
// server runtime. The emitted handlers are erasable TS, no `any`, explicit
// returns. Each builder is ≤50 lines of EMITTER source.

import { lit } from "./mcp-server-lit.js";

// ─── Tool definitions (tools/list) ────────────────────────────────────────────

export function buildToolDefs(): string {
  const searchDesc =
    "Search this API's operations by keyword. Use this FIRST to discover the operation id you need, then call describe_operation or invoke_operation. Matches operation ids, summaries, paths, and descriptions.";
  const describeDesc =
    "Show the full signature of one operation: HTTP method and path, summary, every parameter (name, location, type, required), auth requirements, and pagination/confirmation notes. Use this before invoke_operation to learn exactly which args to pass.";
  const invokeDesc =
    "Execute one operation against the live API. Pass the operation id and an args object keyed by parameter name. Destructive operations require confirm: true. Returns the JSON response body.";
  return `
const TOOLS: readonly ToolDef[] = [
  {
    name: "search_operations",
    description: ${lit(searchDesc)},
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to match." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "Max hits (default 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "describe_operation",
    description: ${lit(describeDesc)},
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Operation id from search_operations." } },
      required: ["id"],
    },
  },
  {
    name: "invoke_operation",
    description: ${lit(invokeDesc)},
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Operation id." },
        args: { type: "object", description: "Args keyed by parameter name." },
        confirm: { type: "boolean", description: "Required (true) for destructive operations." },
      },
      required: ["id"],
    },
  },
];`;
}

// ─── search_operations ────────────────────────────────────────────────────────

export function buildSearch(): string {
  return `
function runSearch(args: Record<string, unknown>): ToolResult {
  const query = typeof args["query"] === "string" ? args["query"] : "";
  const rawLimit = typeof args["limit"] === "number" ? args["limit"] : 10;
  const limit = Math.max(1, Math.min(25, Math.floor(rawLimit)));
  const queryTokens = tokenize(query);
  const scored = CATALOG.map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
    .filter((x) => x.score > 0);
  // Stable sort: score desc, then id asc.
  scored.sort((a, b) =>
    (b.score - a.score) || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0),
  );
  if (scored.length === 0) {
    const examples = CATALOG.slice(0, 5).map((e) => e.id).join(", ");
    return text("No matches. Example operations: " + examples);
  }
  const lines = scored.slice(0, limit).map((x) => {
    const e = x.entry;
    const suffix = e.annotations.destructive ? " [destructive]" : "";
    return e.id + " — " + e.httpMethod + " " + e.path + " — " + e.summary + suffix;
  });
  return text(lines.join("\\n"));
}`;
}

// ─── describe_operation ───────────────────────────────────────────────────────

export function buildDescribe(
  envPrefix: string,
  baseUrl: string | null,
  authEnvVars: readonly string[],
): string {
  const baseUrlEnv = `${envPrefix}_BASE_URL`;
  const authNames = authEnvVars.length > 0 ? authEnvVars.join(", ") : "(none)";
  // The base-url note only fires when the baked default is null.
  // Compose the full string at generation time (M1: no runtime string concat of constants).
  const baseUrlNote =
    baseUrl === null
      ? `lines.push(${lit("Base URL: not baked in — set " + baseUrlEnv + ".")});`
      : `lines.push(${lit("Base URL: " + baseUrl + " (override with " + baseUrlEnv + ")")});`;
  return `
function runDescribe(args: Record<string, unknown>): ToolResult {
  const id = typeof args["id"] === "string" ? args["id"] : "";
  const entry = findEntry(id);
  if (entry === undefined) {
    const suggestions = closestIds(id, 3).join(", ");
    return text("Unknown operation '" + id + "'. Closest: " + suggestions, true);
  }
  const lines: string[] = [];
  lines.push(entry.id + " — " + entry.httpMethod + " " + entry.path);
  if (entry.summary) lines.push(entry.summary);
  if (entry.description) lines.push(entry.description);
  lines.push("");
  lines.push("Parameters:");
  if (entry.params.length === 0) {
    lines.push("  (none)");
  } else {
    for (const p of entry.params) {
      const req = p.required ? "required" : "optional";
      lines.push("  " + p.name + " — " + p.in + " — " + p.type + " — " + req);
    }
  }
  const a = entry.annotations;
  lines.push("Annotations: destructive=" + a.destructive + ", readOnly=" + a.readOnly + ", idempotent=" + a.idempotent);
  if (entry.paginated) {
    lines.push("Pagination: accepts cursor/offset params; the SDK exposes a " + entry.accessor[1] + "Pages helper.");
  }
  lines.push(${lit("Auth: set " + authNames + ".")});
  ${baseUrlNote}
  if (a.destructive) {
    lines.push("Destructive: invoke_operation requires confirm: true.");
  }
  return text(lines.join("\\n"));
}`;
}

// ─── invoke_operation ─────────────────────────────────────────────────────────

export function buildInvoke(envPrefix: string, baseUrl: string | null): string {
  return buildInvokeHelpers(envPrefix, baseUrl) + buildRunInvoke(envPrefix);
}

// Emits the Gateway alias, resolveBaseUrl, and the strict arg router.
function buildInvokeHelpers(envPrefix: string, baseUrl: string | null): string {
  const baseUrlEnv = `${envPrefix}_BASE_URL`;
  const bakedBaseUrl = baseUrl === null ? "null" : lit(baseUrl);
  // Compose the env-var key as a literal (M1: generation-time constant, no runtime concat).
  const baseUrlEnvLit = lit(baseUrlEnv);
  return `
type Gateway = ReturnType<typeof attachResources>;

function resolveBaseUrl(env: Record<string, string | undefined>): string | null {
  return env[${baseUrlEnvLit}] ?? ${bakedBaseUrl};
}

function routeArgs(
  entry: CatalogEntry,
  args: Record<string, unknown>,
): { ok: true; opts: Record<string, unknown> } | { ok: false; message: string } {
  const valid = new Set(entry.params.map((p) => p.name));
  const unknown = Object.keys(args).filter((k) => !valid.has(k));
  if (unknown.length > 0) {
    const names = entry.params.map((p) => p.name).join(", ") || "(none)";
    return { ok: false, message: "unknown_args: " + unknown.join(", ") + ". Valid params: " + names };
  }
  const missing = entry.params.filter((p) => p.required && !(p.name in args));
  if (missing.length > 0) {
    const names = missing.map((p) => p.name + " (" + p.in + ")").join(", ");
    return { ok: false, message: "missing_args: " + entry.id + " requires: " + names };
  }
  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  let body: unknown = undefined;
  for (const p of entry.params) {
    if (!(p.name in args)) continue;
    if (p.in === "path") pathParams[p.name] = args[p.name];
    else if (p.in === "query") query[p.name] = args[p.name];
    else body = args[p.name];
  }
  const opts: Record<string, unknown> = {};
  if (Object.keys(pathParams).length > 0) opts["pathParams"] = pathParams;
  if (Object.keys(query).length > 0) opts["query"] = query;
  if (body !== undefined) opts["body"] = body;
  return { ok: true, opts };
}
`;
}

// Emits runInvoke: unknown-id suggestions, confirm gate, arg routing, lazy
// client dispatch, truncation, and SDK-error → isError.
function buildRunInvoke(envPrefix: string): string {
  const baseUrlEnv = `${envPrefix}_BASE_URL`;
  const allowEnv = `${envPrefix}_MCP_ALLOW_DESTRUCTIVE`;
  // Compose generation-time constants as single literals (M1: no runtime string concat).
  const allowEnvLit = lit(allowEnv);
  const baseUrlNotSetMsg = lit("base_url_not_set: set " + baseUrlEnv + ".");
  return `
async function runInvoke(
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  getClient: () => Gateway,
): Promise<ToolResult> {
  const id = typeof args["id"] === "string" ? args["id"] : "";
  const entry = findEntry(id);
  if (entry === undefined) {
    return text("Unknown operation '" + id + "'. Closest: " + closestIds(id, 3).join(", "), true);
  }
  const callArgs =
    typeof args["args"] === "object" && args["args"] !== null && !Array.isArray(args["args"])
      ? (args["args"] as Record<string, unknown>)
      : {};
  const confirm = args["confirm"] === true;
  if (entry.annotations.destructive && !confirm && env[${allowEnvLit}] !== "1") {
    return text(
      "destructive_confirmation_required: " + entry.id + " is destructive (" +
        entry.httpMethod + " " + entry.path +
        "). Re-invoke with confirm: true after user approval.",
      true,
    );
  }
  const routed = routeArgs(entry, callArgs);
  if (!routed.ok) return text(routed.message, true);
  const baseUrl = resolveBaseUrl(env);
  if (baseUrl === null) {
    return text(${baseUrlNotSetMsg}, true);
  }
  try {
    const client = getClient();
    // accessor[0] is a ResourceTree group key, but Gateway is Client &
    // ResourceTree, so indexing by keyof Gateway yields a union that also
    // includes Client's own members (request method, baseUrl, …) whose shapes
    // do not overlap the resource record. Go through unknown — the catalog
    // guarantees accessor points at a real resource method.
    const ns = client[entry.accessor[0] as keyof Gateway] as unknown as Record<
      string,
      (opts?: Record<string, unknown>) => Promise<unknown>
    >;
    const result = await ns[entry.accessor[1]](routed.opts);
    let out: string;
    if (result instanceof Response) {
      const raw = await result.text();
      try {
        out = JSON.stringify(JSON.parse(raw) as unknown, null, 2);
      } catch {
        out = raw;
      }
    } else {
      out = JSON.stringify(result, null, 2);
    }
    if (out.length > MAX_RESULT_CHARS) {
      out = out.slice(0, MAX_RESULT_CHARS) + "\\n…[truncated — response exceeded 50,000 characters]";
    }
    return text(out);
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    return text(name + ": " + message, true);
  }
}`;
}
