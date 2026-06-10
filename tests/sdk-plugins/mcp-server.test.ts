// tests/sdk-plugins/mcp-server.test.ts
// TDD phase: source-pattern assertions + runtime-behavior tests.
//
// Runtime tests transpile the emitted mcp-server.ts string with typescript's
// transpileModule() and evaluate it via a Function wrapper with a require()
// shim that resolves the emitted module's four imports:
//   ./mcp-catalog.js   → a STUB CATALOG fixture (destructive op, paginated op,
//                        plain GET, distinct summaries for scoring).
//   ./mcp-protocol.js  → the REAL emitted protocol module (transpiled too).
//   ./runtime.js       → a fake Client capturing constructor opts.
//   ./resources.js     → fake attachResources whose namespace.method records
//                        calls and returns scripted data.
// This combination (real protocol + stub catalog/runtime/resources) exercises
// the actual createGateway()/search/describe/invoke implementation end to end.

import { describe, expect, test } from "vitest";
import ts from "typescript";
import { generateMcpServerModule } from "../../src/sdk-plugins/mcp-server.js";
import { generateMcpProtocolModule } from "../../src/sdk-plugins/mcp-protocol.js";

// ─── Shared emitter options ──────────────────────────────────────────────────

const OPTS = {
  productName: "agentmin",
  envPrefix: "AGENTMIN",
  baseUrl: "https://api.agentmin.test" as string | null,
  pkgVersion: "1.2.3",
  authEnvVars: ["AGENTMIN_CLIENT_ID", "AGENTMIN_CLIENT_SECRET"] as readonly string[],
};

const OPTS_NO_BASEURL = { ...OPTS, baseUrl: null as string | null };

// ─── Stub CATALOG fixture (transpiled as ./mcp-catalog.js) ────────────────────
// Hand-written so scoring inputs are precise and stable:
//   items_delete — DELETE, destructive, summary "Delete an item permanently"
//   logs_list    — GET, paginated, summary "List recent activity logs"
//   items_get    — GET, plain, summary "Retrieve a single widget by id"

const STUB_CATALOG_SRC = `
export const CATALOG = [
  {
    id: "items_delete",
    accessor: ["items", "remove"],
    httpMethod: "DELETE",
    path: "/items/{id}",
    summary: "Delete an item permanently",
    description: "Permanently removes the item and all of its revisions.",
    searchText: "items_delete delete an item permanently /items/{id} permanently removes the item and all of its revisions.",
    params: [
      { name: "id", in: "path", type: "string", required: true },
    ],
    annotations: { destructive: true, readOnly: false, idempotent: true },
    paginated: false,
  },
  {
    id: "logs_list",
    accessor: ["logs", "list"],
    httpMethod: "GET",
    path: "/logs",
    summary: "List recent activity logs",
    description: "Returns a page of audit log records.",
    searchText: "logs_list list recent activity logs /logs returns a page of audit log records.",
    params: [
      { name: "limit", in: "query", type: "integer", required: false },
      { name: "cursor", in: "query", type: "string", required: false },
    ],
    annotations: { destructive: false, readOnly: true, idempotent: true },
    paginated: true,
  },
  {
    id: "items_get",
    accessor: ["items", "get"],
    httpMethod: "GET",
    path: "/items/{id}",
    summary: "Retrieve a single widget by id",
    description: "Fetches one widget. The word delete appears here in description only.",
    searchText: "items_get retrieve a single widget by id /items/{id} fetches one widget. the word delete appears here in description only.",
    params: [
      { name: "id", in: "path", type: "string", required: true },
      { name: "expand", in: "query", type: "string", required: false },
    ],
    annotations: { destructive: false, readOnly: true, idempotent: true },
    paginated: false,
  },
];
`;

// ─── Runtime harness types ────────────────────────────────────────────────────

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: number | string | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface GatewayDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

interface EmittedServer {
  createGateway: (
    deps?: GatewayDeps,
  ) => (msg: JsonRpcRequest) => Promise<JsonRpcResponse | null>;
  main: () => void;
}

/** A recorded call against the fake resource accessor. */
interface RecordedCall {
  namespace: string;
  method: string;
  opts: Record<string, unknown> | undefined;
}

/** Knobs the fake runtime/resources read to script their behavior. */
interface FakeKnobs {
  // Records every Client constructor opts object.
  clientOpts: Array<Record<string, unknown>>;
  // Records every resource method invocation.
  calls: RecordedCall[];
  // If set, the named accessor method throws this error instead of returning data.
  throwOn: { namespace: string; method: string; error: Error } | null;
  // Scripted return value for any successful accessor call.
  returnValue: unknown;
  // If true, the Client constructor throws a ConfigError (simulating env-less auth).
  clientThrows: Error | null;
}

function transpile(src: string): string {
  return ts.transpileModule(src, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
}

/** Evaluate a transpiled CJS string with a require shim, returning its exports. */
function evalModule(
  cjs: string,
  requireShim: (spec: string) => Record<string, unknown>,
): Record<string, unknown> {
  const wrapper = new Function("exports", "require", "module", cjs);
  const exports: Record<string, unknown> = {};
  const moduleObj = { exports };
  wrapper(exports, requireShim, moduleObj);
  return moduleObj.exports as Record<string, unknown>;
}

/**
 * Build the fake ./runtime.js and ./resources.js exports backed by `knobs`.
 * Client captures constructor opts (or throws). attachResources returns a proxy
 * whose namespace.method records the call and returns scripted data / throws.
 */
function makeFakeRuntimeAndResources(knobs: FakeKnobs): {
  runtime: Record<string, unknown>;
  resources: Record<string, unknown>;
} {
  class FakeClient {
    readonly opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      if (knobs.clientThrows) throw knobs.clientThrows;
      this.opts = opts;
      knobs.clientOpts.push(opts);
    }
  }
  const NAMESPACES = ["items", "logs", "oauth"];
  const METHODS = ["remove", "list", "get", "token", "create"];
  function attachResources(
    client: Record<string, unknown>,
  ): Record<string, unknown> {
    for (const ns of NAMESPACES) {
      const nsObj: Record<string, unknown> = {};
      for (const method of METHODS) {
        nsObj[method] = (opts?: Record<string, unknown>): Promise<unknown> => {
          knobs.calls.push({ namespace: ns, method, opts });
          if (
            knobs.throwOn &&
            knobs.throwOn.namespace === ns &&
            knobs.throwOn.method === method
          ) {
            return Promise.reject(knobs.throwOn.error);
          }
          return Promise.resolve(knobs.returnValue);
        };
      }
      client[ns] = nsObj;
    }
    return client;
  }
  return {
    runtime: { Client: FakeClient },
    resources: { attachResources },
  };
}

/** Load the emitted gateway with the real protocol module + stub deps. */
function loadGateway(
  opts: Parameters<typeof generateMcpServerModule>[0],
  knobs: FakeKnobs,
): EmittedServer {
  const protocolCjs = transpile(generateMcpProtocolModule());
  const protocolExports = evalModule(protocolCjs, () => {
    throw new Error("protocol module needs no imports");
  });
  const catalogExports = evalModule(transpile(STUB_CATALOG_SRC), () => {
    throw new Error("catalog stub needs no imports");
  });
  const { runtime, resources } = makeFakeRuntimeAndResources(knobs);
  const requireShim = (spec: string): Record<string, unknown> => {
    if (spec === "./mcp-protocol.js") return protocolExports;
    if (spec === "./mcp-catalog.js") return catalogExports;
    if (spec === "./runtime.js") return runtime;
    if (spec === "./resources.js") return resources;
    throw new Error(`unexpected import: ${spec}`);
  };
  const serverCjs = transpile(generateMcpServerModule(opts));
  return evalModule(serverCjs, requireShim) as unknown as EmittedServer;
}

function freshKnobs(): FakeKnobs {
  return {
    clientOpts: [],
    calls: [],
    throwOn: null,
    returnValue: { ok: true },
    clientThrows: null,
  };
}

/** Call a tool through the gateway and return the ToolResult. */
async function callTool(
  handler: (msg: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Promise<ToolResult> {
  const res = await handler({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (res === null) throw new Error("unexpected null response");
  if (res.error) throw new Error(`unexpected JSON-RPC error: ${res.error.message}`);
  return res.result as ToolResult;
}

/** Fetch the tools/list array. */
async function listTools(
  handler: (msg: JsonRpcRequest) => Promise<JsonRpcResponse | null>,
): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
  const res = await handler({ jsonrpc: "2.0", id: 99, method: "tools/list" });
  const result = res!.result as Record<string, unknown>;
  return result["tools"] as Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
}

// ════════════════════════════════════════════════════════════════════════════
// Source-pattern tests
// ════════════════════════════════════════════════════════════════════════════

describe("generateMcpServerModule — source contract", () => {
  test("emits header comment and no-edit guard", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("Auto-generated by @skillship/sdk-plugin-mcp-server");
    expect(src).toContain("Do not edit by hand");
  });

  test("imports use .js specifiers from the four sibling modules", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain('from "./mcp-catalog.js"');
    expect(src).toContain('from "./mcp-protocol.js"');
    expect(src).toContain('from "./runtime.js"');
    expect(src).toContain('from "./resources.js"');
  });

  test("imports the real exported symbols", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("CATALOG");
    expect(src).toContain("CatalogEntry");
    expect(src).toContain("makeProtocolHandler");
    expect(src).toContain("runStdioServer");
    expect(src).toContain("ToolDef");
    expect(src).toContain("ToolResult");
    expect(src).toContain("JsonRpcRequest");
    expect(src).toContain("JsonRpcResponse");
    expect(src).toContain("Client");
    expect(src).toContain("attachResources");
  });

  test("declares a narrow process ambient with env (consistent with auth module)", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("declare const process");
    expect(src).toContain("env: Record<string, string | undefined>");
    // Must NOT redeclare the wide stdin/stdout shape owned by mcp-protocol.
    expect(src).not.toContain("stdin");
    expect(src).not.toContain("stdout");
  });

  test("exports GatewayDeps with optional fetchImpl and env", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("export interface GatewayDeps");
    expect(src).toContain("fetchImpl?: typeof fetch");
    expect(src).toContain("env?: Record<string, string | undefined>");
  });

  test("exports createGateway returning the protocol handler signature", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toMatch(/export\s+function\s+createGateway/);
    expect(src).toContain("makeProtocolHandler");
    // Options-object call (not positional)
    expect(src).toContain("serverName");
    expect(src).toContain("serverVersion");
    expect(src).toContain("tools");
    expect(src).toContain("callTool");
  });

  test("serverName and serverVersion bake the product name and version", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain('"agentmin-mcp"');
    expect(src).toContain('"1.2.3"');
  });

  test("exports main that runs the stdio server but does not call it at top level", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toMatch(/export\s+function\s+main/);
    expect(src).toContain("runStdioServer(createGateway())");
    // The last non-empty meaningful lines must NOT be a bare main() invocation.
    const lines = src.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines).not.toContain("main();");
  });

  test("emits all three tool names", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("search_operations");
    expect(src).toContain("describe_operation");
    expect(src).toContain("invoke_operation");
  });

  test("search_operations schema: query required, limit integer min 1 max 25", () => {
    const src = generateMcpServerModule(OPTS);
    // Emitted as a TS object literal (unquoted keys), not JSON.
    expect(src).toContain("query:");
    expect(src).toContain("limit:");
    expect(src).toContain("minimum: 1");
    expect(src).toContain("maximum: 25");
    expect(src).toContain('required: ["query"]');
  });

  test("invoke_operation schema: id required, args object, confirm boolean", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain('"confirm"');
    expect(src).toContain('"args"');
  });

  test("bakes the destructive gate env var and confirmation message", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("AGENTMIN_MCP_ALLOW_DESTRUCTIVE");
    expect(src).toContain("destructive_confirmation_required");
    expect(src).toContain("confirm: true");
  });

  test("bakes the base url default literal and the base url env var name", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("AGENTMIN_BASE_URL");
    expect(src).toContain('"https://api.agentmin.test"');
  });

  test("bakes a null base url default when baseUrl is null", () => {
    const src = generateMcpServerModule(OPTS_NO_BASEURL);
    expect(src).toContain("AGENTMIN_BASE_URL");
    // The baked default must be the null literal, not a quoted URL.
    expect(src).toContain("?? null");
  });

  test("truncation constant is 50000 with the truncated marker", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("50000");
    expect(src).toContain("truncated");
  });

  test("describe auth section names the baked auth env vars", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).toContain("AGENTMIN_CLIENT_ID");
    expect(src).toContain("AGENTMIN_CLIENT_SECRET");
  });

  test("constructs the lazy client via attachResources(new Client(...))", () => {
    const src = generateMcpServerModule(OPTS);
    // The wrapping may break across lines for the 80-col house style; assert the
    // two calls compose (attachResources receives a new Client).
    expect(src).toContain("attachResources(");
    expect(src).toContain("new Client({ baseUrl,");
  });

  test("no any types in emitted module", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).not.toMatch(/:\s*any(\s|[;,)\]]|$)/);
    expect(src).not.toContain("<any>");
    expect(src).not.toContain(" as any");
  });

  test("no enums or namespaces in emitted module", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src).not.toMatch(/\benum\b/);
    expect(src).not.toMatch(/\bnamespace\b/);
  });

  test("emitted output is under 300 lines for the agent fixture", () => {
    const src = generateMcpServerModule(OPTS);
    expect(src.split("\n").length).toBeLessThanOrEqual(300);
  });

  test("emitted output is deterministic across multiple calls", () => {
    expect(generateMcpServerModule(OPTS)).toBe(generateMcpServerModule(OPTS));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — tools/list
// ════════════════════════════════════════════════════════════════════════════

describe("createGateway — tools/list", () => {
  test("lists exactly the three operation tools with object input schemas", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const handler = mod.createGateway();
    const tools = await listTools(handler);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_operation",
      "invoke_operation",
      "search_operations",
    ]);
    for (const t of tools) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.inputSchema["type"]).toBe("object");
    }
  });

  test("search_operations input schema enforces min/max on limit", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const tools = await listTools(mod.createGateway());
    const search = tools.find((t) => t.name === "search_operations")!;
    const props = search.inputSchema["properties"] as Record<string, Record<string, unknown>>;
    expect((search.inputSchema["required"] as string[])).toContain("query");
    expect(props["limit"]["minimum"]).toBe(1);
    expect(props["limit"]["maximum"]).toBe(25);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — search_operations
// ════════════════════════════════════════════════════════════════════════════

describe("createGateway — search_operations", () => {
  test("id-token match outranks a description-only match", async () => {
    // "delete" matches items_delete's id (weight 4) and items_get's description
    // (weight 1). items_delete must rank first.
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "search_operations", {
      query: "delete",
    });
    const text = result.content[0].text;
    const firstLine = text.split("\n").find((l) => l.includes("—"))!;
    expect(firstLine).toContain("items_delete");
    // items_delete appears before items_get in the output.
    expect(text.indexOf("items_delete")).toBeLessThan(text.indexOf("items_get"));
  });

  test("destructive hits carry the [destructive] suffix", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "search_operations", {
      query: "delete",
    });
    const line = result.content[0].text
      .split("\n")
      .find((l) => l.includes("items_delete"))!;
    expect(line).toContain("DELETE");
    expect(line).toContain("/items/{id}");
    expect(line).toContain("[destructive]");
  });

  test("limit clamps to a maximum of 25", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    // query matches all three (each contains a common token via summary words);
    // a huge limit must not error and must not exceed available hits.
    const result = await callTool(mod.createGateway(), "search_operations", {
      query: "list",
      limit: 1000,
    });
    expect(result.isError).toBeFalsy();
    const hitLines = result.content[0].text.split("\n").filter((l) => l.includes(" — "));
    expect(hitLines.length).toBeLessThanOrEqual(25);
  });

  test("limit of 1 returns a single hit", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "search_operations", {
      query: "item",
      limit: 1,
    });
    const hitLines = result.content[0].text.split("\n").filter((l) => l.includes(" — "));
    expect(hitLines.length).toBe(1);
  });

  test("zero matches lists up to 5 example ids", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "search_operations", {
      query: "zzzznomatchtoken",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No matches");
    expect(result.content[0].text).toContain("items_delete");
  });

  test("results are deterministic across identical queries", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const a = await callTool(mod.createGateway(), "search_operations", { query: "item logs" });
    const b = await callTool(mod.createGateway(), "search_operations", { query: "item logs" });
    expect(a.content[0].text).toBe(b.content[0].text);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — describe_operation
// ════════════════════════════════════════════════════════════════════════════

describe("createGateway — describe_operation", () => {
  test("renders method, path, summary, and a params table", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "describe_operation", {
      id: "items_delete",
    });
    const text = result.content[0].text;
    expect(text).toContain("DELETE");
    expect(text).toContain("/items/{id}");
    expect(text).toContain("Delete an item permanently");
    // params table includes the path param
    expect(text).toContain("id");
    expect(text).toContain("path");
  });

  test("names the baked auth env vars in the auth section", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "describe_operation", {
      id: "items_get",
    });
    expect(result.content[0].text).toContain("AGENTMIN_CLIENT_ID");
    expect(result.content[0].text).toContain("AGENTMIN_CLIENT_SECRET");
  });

  test("destructive op carries a confirm note", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "describe_operation", {
      id: "items_delete",
    });
    expect(result.content[0].text).toContain("confirm: true");
  });

  test("paginated op carries a pagination note naming the pages helper", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "describe_operation", {
      id: "logs_list",
    });
    const text = result.content[0].text;
    expect(text.toLowerCase()).toContain("cursor");
    // names the <method>Pages helper (accessor method is "list" → listPages)
    expect(text).toContain("listPages");
  });

  test("emits a base-url note when the baked default is null", async () => {
    const mod = loadGateway(OPTS_NO_BASEURL, freshKnobs());
    const result = await callTool(mod.createGateway(), "describe_operation", {
      id: "items_get",
    });
    expect(result.content[0].text).toContain("AGENTMIN_BASE_URL");
  });

  test("unknown id returns isError with 3 closest suggestions", async () => {
    const mod = loadGateway(OPTS, freshKnobs());
    const result = await callTool(mod.createGateway(), "describe_operation", {
      id: "items_delet",
    });
    expect(result.isError).toBe(true);
    // closest by id-token scorer should surface items_delete
    expect(result.content[0].text).toContain("items_delete");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Runtime — invoke_operation
// ════════════════════════════════════════════════════════════════════════════

describe("createGateway — invoke_operation", () => {
  test("destructive op without confirm refuses with the gate message", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_delete",
      args: { id: "x1" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("destructive_confirmation_required");
    expect(result.content[0].text).toContain("items_delete");
    // no accessor call happened
    expect(knobs.calls).toHaveLength(0);
  });

  test("destructive op WITH confirm:true executes", async () => {
    const knobs = freshKnobs();
    knobs.returnValue = { deleted: true };
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_delete",
      args: { id: "x1" },
      confirm: true,
    });
    expect(result.isError).toBeFalsy();
    expect(knobs.calls).toHaveLength(1);
    expect(knobs.calls[0].namespace).toBe("items");
    expect(knobs.calls[0].method).toBe("remove");
  });

  test("ALLOW_DESTRUCTIVE=1 env override executes without confirm", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(
      mod.createGateway({ env: { AGENTMIN_MCP_ALLOW_DESTRUCTIVE: "1" } }),
      "invoke_operation",
      { id: "items_delete", args: { id: "x1" } },
    );
    expect(result.isError).toBeFalsy();
    expect(knobs.calls).toHaveLength(1);
  });

  test("routes path/query/body args into the accessor opts", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    // items_get has id(path) and expand(query). Drive it.
    await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_get",
      args: { id: "abc", expand: "owner" },
    });
    expect(knobs.calls).toHaveLength(1);
    const opts = knobs.calls[0].opts as Record<string, Record<string, unknown>>;
    expect(opts["pathParams"]).toEqual({ id: "abc" });
    expect(opts["query"]).toEqual({ expand: "owner" });
  });

  test("unknown arg key returns isError listing valid params", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_get",
      args: { id: "abc", bogus: 1 },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("bogus");
    // names the valid params
    expect(result.content[0].text).toContain("id");
    expect(result.content[0].text).toContain("expand");
    expect(knobs.calls).toHaveLength(0);
  });

  test("base url null with no env returns isError naming the env var", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS_NO_BASEURL, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_get",
      args: { id: "abc" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("AGENTMIN_BASE_URL");
    expect(knobs.calls).toHaveLength(0);
  });

  test("env AGENTMIN_BASE_URL overrides the baked default and reaches the Client", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS_NO_BASEURL, knobs);
    await callTool(
      mod.createGateway({ env: { AGENTMIN_BASE_URL: "https://override.test" } }),
      "invoke_operation",
      { id: "items_get", args: { id: "abc" } },
    );
    expect(knobs.clientOpts).toHaveLength(1);
    expect(knobs.clientOpts[0]["baseUrl"]).toBe("https://override.test");
  });

  test("client is a lazy singleton: two invokes construct one Client", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const handler = mod.createGateway({ env: {} });
    await callTool(handler, "invoke_operation", { id: "items_get", args: { id: "a" } }, 1);
    await callTool(handler, "invoke_operation", { id: "items_get", args: { id: "b" } }, 2);
    expect(knobs.clientOpts).toHaveLength(1);
    expect(knobs.calls).toHaveLength(2);
  });

  test("fetchImpl from deps is forwarded into the Client opts", async () => {
    const knobs = freshKnobs();
    const fakeFetch = (async () => new Response("{}")) as unknown as typeof fetch;
    const mod = loadGateway(OPTS, knobs);
    await callTool(
      mod.createGateway({ env: {}, fetchImpl: fakeFetch }),
      "invoke_operation",
      { id: "items_get", args: { id: "a" } },
    );
    expect(knobs.clientOpts[0]["fetch"]).toBe(fakeFetch);
  });

  test("large response is truncated with the marker", async () => {
    const knobs = freshKnobs();
    knobs.returnValue = { blob: "x".repeat(60000) };
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_get",
      args: { id: "a" },
    });
    const text = result.content[0].text;
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(60000);
  });

  test("a thrown SDK error becomes an isError result naming the error", async () => {
    const knobs = freshKnobs();
    const err = new Error("not found");
    err.name = "NotFoundError";
    knobs.throwOn = { namespace: "items", method: "get", error: err };
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_get",
      args: { id: "a" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("NotFoundError");
    expect(result.content[0].text).toContain("not found");
  });

  test("unknown id returns isError with suggestions (same as describe)", async () => {
    const knobs = freshKnobs();
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_gett",
      args: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("items_get");
    expect(knobs.calls).toHaveLength(0);
  });

  test("Client ConfigError (env-less auth) surfaces as isError text", async () => {
    const knobs = freshKnobs();
    const cfgErr = new Error("no auth configured: set AGENTMIN_CLIENT_ID");
    cfgErr.name = "ConfigError";
    knobs.clientThrows = cfgErr;
    const mod = loadGateway(OPTS, knobs);
    const result = await callTool(mod.createGateway({ env: {} }), "invoke_operation", {
      id: "items_get",
      args: { id: "a" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("ConfigError");
  });
});
