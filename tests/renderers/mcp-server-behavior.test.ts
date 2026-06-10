// tests/renderers/mcp-server-behavior.test.ts
// Behavioral suite for the MCP gateway (items 1-7 of spec + missing-args contract).
// Imports DIRECTLY from committed golden sources — resolves .js → .ts at test time.
// Zero real network, zero real timers.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGateway,
  type GatewayDeps,
} from "../fixtures/golden/sdk-agent-minimal/src/mcp-server.js";
import type { JsonRpcRequest } from "../fixtures/golden/sdk-agent-minimal/src/mcp-protocol.js";

// ─── shared constants ─────────────────────────────────────────────────────────

const TOKEN_URL = "https://api.agentmin.test/oauth/token";
const BASE_URL = "https://api.agentmin.test/v1";

// ─── fake fetch infrastructure ────────────────────────────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

type FakeHandler = (call: RecordedCall) => Response;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function tokenResponse(token = "test-token", expiresIn = 3600): Response {
  return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

function queueResponses(responses: Response[]): FakeHandler {
  let i = 0;
  return () => {
    if (i >= responses.length) throw new Error("fake fetch: queue drained");
    return responses[i++]!;
  };
}

function makeFetch(
  tokenHandler: FakeHandler,
  apiHandler: FakeHandler,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const body =
      req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    const call: RecordedCall = {
      url: req.url,
      method: req.method,
      authorization: req.headers.get("authorization"),
      contentType: req.headers.get("content-type"),
      body,
    };
    calls.push(call);
    if (req.url === TOKEN_URL) return tokenHandler(call);
    return apiHandler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeGateway(deps?: GatewayDeps): (msg: JsonRpcRequest) => Promise<unknown> {
  return createGateway(deps);
}

async function callGateway(
  handler: (msg: JsonRpcRequest) => Promise<unknown>,
  msg: JsonRpcRequest,
): Promise<Record<string, unknown>> {
  const res = await handler(msg);
  return res as Record<string, unknown>;
}

function req(
  method: string,
  params?: Record<string, unknown>,
  id: number | string = 1,
): JsonRpcRequest {
  return { jsonrpc: "2.2" as "2.0", id, method, params } as unknown as JsonRpcRequest;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. initialize / initialized / ping shapes ────────────────────────────────

describe("1. initialize / initialized / ping shapes", () => {
  test("initialize returns exact protocolVersion and serverInfo", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(1);
    const result = res.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("agentmin-mcp");
    expect(serverInfo.version).toBe("0.1.0");
    expect(result.capabilities).toBeDefined();
  });

  test("notifications/initialized returns null (no response)", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    // notifications have no id field
    const res = await handler({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    } as JsonRpcRequest);
    expect(res).toBeNull();
  });

  test("ping returns empty result object", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, { jsonrpc: "2.0", id: 2, method: "ping" });
    const result = res.result as Record<string, unknown>;
    expect(result).toEqual({});
  });
});

// ─── 2. tools/list schemas exact ─────────────────────────────────────────────

describe("2. tools/list schemas exact", () => {
  test("returns exactly three tools with correct schemas", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const { tools } = res.result as { tools: Array<Record<string, unknown>> };
    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t.name);
    expect(names).toContain("invoke_operation");
    expect(names).toContain("search_operations");
    expect(names).toContain("describe_operation");

    // invoke_operation: required ["id"], confirm boolean, args object
    const invoke = tools.find((t) => t.name === "invoke_operation")!;
    const invokeSchema = invoke.inputSchema as Record<string, unknown>;
    expect((invokeSchema.required as string[])).toContain("id");
    expect((invokeSchema.required as string[])).not.toContain("confirm");
    const invokeProps = invokeSchema.properties as Record<string, Record<string, unknown>>;
    expect(invokeProps["confirm"]?.type).toBe("boolean");
    expect(invokeProps["args"]?.type).toBe("object");

    // search_operations: required ["query"], limit min 1 max 25
    const search = tools.find((t) => t.name === "search_operations")!;
    const searchSchema = search.inputSchema as Record<string, unknown>;
    expect((searchSchema.required as string[])).toContain("query");
    const searchProps = searchSchema.properties as Record<string, Record<string, unknown>>;
    expect(searchProps["limit"]?.minimum).toBe(1);
    expect(searchProps["limit"]?.maximum).toBe(25);

    // describe_operation: required ["id"]
    const describe_ = tools.find((t) => t.name === "describe_operation")!;
    const describeSchema = describe_.inputSchema as Record<string, unknown>;
    expect((describeSchema.required as string[])).toContain("id");
  });
});

// ─── 3. search determinism + weighting + limit + zero-match ──────────────────

describe("3. search determinism, weighting, limit clamp, zero-match", () => {
  test("two identical search calls return byte-identical text", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const call1 = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_operations", arguments: { query: "items" } },
    });
    const call2 = await callGateway(handler, {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "search_operations", arguments: { query: "items" } },
    });
    const t1 = (call1.result as { content: Array<{ text: string }> }).content[0]!.text;
    const t2 = (call2.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(t1).toBe(t2);
  });

  test("id-token match (items_create) outranks description-only match", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_operations", arguments: { query: "items" } },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // items_create and items_list both have "items" in their id → rank above logs_list
    // which only matches via description. Check the first result is an items_ op.
    expect(lines[0]).toMatch(/^items_/);
  });

  test("limit clamp: limit=2 returns at most 2 results", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_operations", arguments: { query: "items", limit: 2 } },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  test("zero-match: response includes example operation ids from catalog", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_operations", arguments: { query: "zzznomatchzzz" } },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    // Should say "No matches" and list example ids
    expect(text).toMatch(/No matches/);
    expect(text).toMatch(/items_create|items_list|logs_list/);
  });
});

// ─── 4. describe: env var names, confirm requirement, pagination note, unknown ──

describe("4. describe_operation content", () => {
  test("shows AGENTMIN_CLIENT_ID and AGENTMIN_CLIENT_SECRET in auth note", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "describe_operation", arguments: { id: "items_list" } },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("AGENTMIN_CLIENT_ID");
    expect(text).toContain("AGENTMIN_CLIENT_SECRET");
  });

  test("items_create description says confirm: true required (destructive annotation)", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "describe_operation", arguments: { id: "items_create" } },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain("confirm: true");
    expect(text).toContain("Destructive");
  });

  test("items_list description contains pagination note with listPages helper", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "describe_operation", arguments: { id: "items_list" } },
    });
    const text = (res.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toMatch(/Pagination/);
    expect(text).toContain("listPages");
  });

  test("unknown id returns isError with 3 suggestions", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "describe_operation", arguments: { id: "totally_unknown_op_xyz" } },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    // 3 suggestions are comma-separated in the text
    const text = result.content[0]!.text;
    const suggestionsMatch = text.match(/Closest: (.+)/);
    expect(suggestionsMatch).not.toBeNull();
    const parts = suggestionsMatch![1]!.split(",").map((s) => s.trim());
    expect(parts.length).toBe(3);
  });
});

// ─── 5. invoke happy path: real SDK auth chain (token POST + Bearer API call) ──

describe("5. invoke happy path — real SDK auth chain", () => {
  test("token POST observed with grant_type=client_credentials + Basic header; API call uses Bearer", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid-test");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec-test");

    const { fetchImpl, calls } = makeFetch(
      () => tokenResponse("auth-tok"),
      () => jsonResponse({ id: "new-item", status: "created" }),
    );
    const handler = makeGateway({ fetchImpl, env: {} });

    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: { id: "items_create", confirm: true, args: { body: { name: "x" } } },
      },
    });

    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();

    const tokenCalls = calls.filter((c) => c.url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    const tc = tokenCalls[0]!;
    expect(tc.method).toBe("POST");
    expect(tc.body).toContain("grant_type=client_credentials");
    expect(tc.authorization).toBe(`Basic ${btoa("cid-test:csec-test")}`);

    const apiCalls = calls.filter((c) => c.url !== TOKEN_URL);
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]!.authorization).toBe("Bearer auth-tok");
  });
});

// ─── 6. gate: destructive confirmation ───────────────────────────────────────

describe("6. destructive confirmation gate", () => {
  test("invoke items_create without confirm → isError destructive_confirmation_required", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "invoke_operation", arguments: { id: "items_create", args: { body: {} } } },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("destructive_confirmation_required");
  });

  test("invoke items_create with confirm: true executes (needs auth env)", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid2");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec2");
    const { fetchImpl } = makeFetch(
      () => tokenResponse("tok2"),
      () => jsonResponse({ id: "created" }),
    );
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: { id: "items_create", confirm: true, args: { body: { name: "y" } } },
      },
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
  });

  test("AGENTMIN_MCP_ALLOW_DESTRUCTIVE=1 in deps.env bypasses confirm requirement", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid3");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec3");
    const { fetchImpl } = makeFetch(
      () => tokenResponse("tok3"),
      () => jsonResponse({ id: "bypassed" }),
    );
    const handler = makeGateway({
      fetchImpl,
      env: { AGENTMIN_MCP_ALLOW_DESTRUCTIVE: "1" },
    });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: { id: "items_create", args: { body: { name: "z" } } },
      },
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
  });
});

// ─── 7. missing creds → ConfigError naming AGENTMIN_CLIENT_ID ─────────────────

describe("7. missing credentials → ConfigError surfaced", () => {
  test("no auth env → invoke returns isError naming AGENTMIN_CLIENT_ID", async () => {
    // ensure env vars are NOT set
    vi.stubEnv("AGENTMIN_CLIENT_ID", "");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "");
    // ConfigError is thrown at Client construction time (when getClient() is called)
    let handler: ((msg: JsonRpcRequest) => Promise<unknown>) | undefined;
    let threw = false;
    try {
      // createGateway itself does NOT build Client eagerly — it defers to first invoke
      handler = makeGateway({ env: {} });
    } catch {
      threw = true;
    }
    if (threw) {
      // Construction threw ConfigError — that satisfies the contract
      expect(threw).toBe(true);
      return;
    }
    // Otherwise invoke should surface the error as isError response
    const res = await callGateway(handler!, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: { id: "items_list" },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("AGENTMIN_CLIENT_ID");
  });
});

// ─── missing required args ────────────────────────────────────────────────────

describe("missing required args contract (Wave-3.5)", () => {
  test("invoke items_create without body arg → isError missing_args naming it", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid4");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec4");
    const { fetchImpl } = makeFetch(() => tokenResponse("t4"), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: {
        name: "invoke_operation",
        arguments: { id: "items_create", confirm: true, args: {} },
      },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("missing_args");
    expect(result.content[0]!.text).toContain("body");
  });
});
