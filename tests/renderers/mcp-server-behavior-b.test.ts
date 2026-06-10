// tests/renderers/mcp-server-behavior-b.test.ts
// Behavioral suite part B — items 8–12 of spec.
// Same golden imports + fake-fetch infrastructure as part A.
// Zero real network, zero real timers.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createGateway,
  type GatewayDeps,
} from "../fixtures/golden/sdk-agent-minimal/src/mcp-server.js";
import type { JsonRpcRequest } from "../fixtures/golden/sdk-agent-minimal/src/mcp-protocol.js";

// ─── shared constants ─────────────────────────────────────────────────────────

const TOKEN_URL = "https://api.agentmin.test/oauth/token";

// ─── fake fetch helpers ───────────────────────────────────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string;
}

type FakeHandler = (call: RecordedCall) => Response;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function tokenResponse(token = "test-tok", expiresIn = 3600): Response {
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
      body,
    };
    calls.push(call);
    if (req.url === TOKEN_URL) return tokenHandler(call);
    return apiHandler(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

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

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 8. unknown operation id → isError + 3 suggestions ───────────────────────

describe("8. invoke unknown operation id → isError + suggestions", () => {
  test("invoke with unknown id returns isError and 3 suggestions", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid-unk");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec-unk");
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "invoke_operation", arguments: { id: "completely_bogus_op_xyz" } },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("Unknown operation");
    // Closest: X, Y, Z — 3 suggestions
    const m = text.match(/Closest: (.+)/);
    expect(m).not.toBeNull();
    const parts = m![1]!.split(",").map((s) => s.trim());
    expect(parts.length).toBe(3);
  });
});

// ─── 9. truncation: API response > 50,000 chars ───────────────────────────────

describe("9. truncation of large API responses", () => {
  test("response > 50,000 chars is truncated with notice", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid-trunc");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec-trunc");
    // Build a payload that serializes to > 50,000 chars
    const bigArray = Array.from({ length: 5001 }, (_, i) => ({ id: i, data: "x".repeat(10) }));
    const { fetchImpl } = makeFetch(
      () => tokenResponse("tok-trunc"),
      () => jsonResponse(bigArray),
    );
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "invoke_operation", arguments: { id: "items_list" } },
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThanOrEqual(50000 + 200); // truncation notice is short
  });
});

// ─── 10. baseUrl env override ─────────────────────────────────────────────────

describe("10. baseUrl env override via deps.env", () => {
  test("AGENTMIN_BASE_URL in deps.env changes the API call host", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid-base");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec-base");
    const OTHER_BASE = "http://other.test";
    const recordedUrls: string[] = [];
    const fetchImpl = (async (
      input: Request | string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      recordedUrls.push(req.url);
      if (req.url === TOKEN_URL) {
        return tokenResponse("tok-base");
      }
      return jsonResponse([]);
    }) as typeof fetch;

    const handler = makeGateway({
      fetchImpl,
      env: { AGENTMIN_BASE_URL: OTHER_BASE },
    });
    await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "invoke_operation", arguments: { id: "items_list" } },
    });
    const apiCalls = recordedUrls.filter((u) => u !== TOKEN_URL);
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls[0]).toContain("other.test");
  });
});

// ─── 11. unknown tool name → isError naming the three tools ──────────────────

describe("11. unknown tool name → isError listing the three tools", () => {
  test("tools/call with unknown tool name returns isError with tool list", async () => {
    const { fetchImpl } = makeFetch(() => tokenResponse(), () => jsonResponse({}));
    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "nonexistent_tool_xyz", arguments: {} },
    });
    const result = res.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("search_operations");
    expect(text).toContain("describe_operation");
    expect(text).toContain("invoke_operation");
  });
});

// ─── 12. retry-through-invoke: 429 + Retry-After: 0 then 200 ─────────────────

describe("12. retry loop through invoke: 429 + Retry-After:0 → success", () => {
  test("fake fetch scripts 429 then 200; records token call + 2 API calls", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "cid-retry");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "csec-retry");

    const apiQueue = queueResponses([
      jsonResponse({}, 429, { "Retry-After": "0" }),
      jsonResponse([{ id: "r1" }]),
    ]);
    const { fetchImpl, calls } = makeFetch(() => tokenResponse("tok-retry"), apiQueue);

    const handler = makeGateway({ fetchImpl, env: {} });
    const res = await callGateway(handler, {
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "invoke_operation", arguments: { id: "items_list" } },
    });
    const result = res.result as { isError?: boolean; content: Array<{ text: string }> };
    // Invoke should succeed after the retry
    expect(result.isError).toBeFalsy();

    const tokenCalls = calls.filter((c) => c.url === TOKEN_URL);
    const apiCalls = calls.filter((c) => c.url !== TOKEN_URL);
    // Exactly 1 token call (token is cached for retry) + 2 API calls (429 then 200)
    expect(tokenCalls).toHaveLength(1);
    expect(apiCalls).toHaveLength(2);
  });
});
