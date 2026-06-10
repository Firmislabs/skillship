// tests/renderers/sdk-runtime-behavior.test.ts
// Behavioral suite for the emitted SDK runtime + auth + pagination. Imports
// DIRECTLY from the committed agent golden sources (the same bytes the
// byte-identity lock guards) so this exercises exactly what customers ship.
//
// Every test injects a fake `fetch` and a recorded `sleep`; ZERO real timers and
// ZERO network. A behavioral failure means the EMITTER is wrong — fix the
// emitter, regenerate goldens, re-lock; never hand-edit a golden.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Client,
  type AuthConfig,
  type ClientOptions,
} from "../fixtures/golden/sdk-agent-minimal/src/runtime.js";
import { attachResources } from "../fixtures/golden/sdk-agent-minimal/src/resources.js";
import {
  ConfigError,
  UnauthorizedError,
} from "../fixtures/golden/sdk-agent-minimal/src/errors.js";

const BASE_URL = "https://api.agentmin.test/v1";
const TOKEN_URL = "https://api.agentmin.test/oauth/token";
const OAUTH_AUTH: AuthConfig = {
  kind: "oauth2",
  clientId: "cid",
  clientSecret: "csecret",
  tokenUrl: TOKEN_URL,
};

// ─── fake fetch infrastructure ────────────────────────────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly contentType: string | null;
  readonly body: string;
}

type Responder = (call: RecordedCall) => Response;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function tokenResponse(token: string, expiresIn = 3600): Response {
  return jsonResponse({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

/**
 * Builds a fake fetch that records every call and dispatches to a per-URL
 * responder. Responders may be functions of the call (so a queue can advance).
 */
function makeFetch(handlers: {
  token?: Responder;
  api: Responder;
}): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // The runtime passes a Request (API calls); AuthManager passes (url, init)
    // for the token endpoint. Normalize both into a Request.
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = req.url;
    const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.clone().text();
    const call: RecordedCall = {
      url,
      method: req.method,
      authorization: req.headers.get("authorization"),
      contentType: req.headers.get("content-type"),
      body,
    };
    calls.push(call);
    if (url === TOKEN_URL) {
      if (!handlers.token) throw new Error(`unexpected token fetch: ${url}`);
      return handlers.token(call);
    }
    return handlers.api(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** A `sleep` that records the requested delays instead of waiting. */
function makeRecordedSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

/** Returns the next response from a queue; throws if drained (catches over-fetch). */
function queue(responses: Response[]): Responder {
  let i = 0;
  return () => {
    if (i >= responses.length) throw new Error("fake fetch: response queue drained");
    return responses[i++]!;
  };
}

function makeClient(
  opts: Partial<ClientOptions> & Pick<ClientOptions, "fetch" | "sleep">,
): Client {
  return new Client({ baseUrl: BASE_URL, auth: OAUTH_AUTH, ...opts });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── 1. oauth2 token fetch + caching ─────────────────────────────────────────

describe("oauth2 token fetch + caching", () => {
  test("first API call fetches the token once (Basic + form body), API call carries Bearer; second call reuses cache", async () => {
    const { sleep } = makeRecordedSleep();
    const { fetchImpl, calls } = makeFetch({
      token: () => tokenResponse("tok-1"),
      api: queue([jsonResponse({ ok: true }), jsonResponse({ ok: true })]),
    });
    const client = makeClient({ fetch: fetchImpl, sleep });

    await client.request({ path: "/items", method: "GET" });
    await client.request({ path: "/items", method: "GET" });

    const tokenCalls = calls.filter((c) => c.url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    const tokenCall = tokenCalls[0]!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.authorization).toBe(`Basic ${btoa("cid:csecret")}`);
    expect(tokenCall.contentType).toContain("application/x-www-form-urlencoded");
    expect(tokenCall.body).toContain("grant_type=client_credentials");

    const apiCalls = calls.filter((c) => c.url !== TOKEN_URL);
    expect(apiCalls).toHaveLength(2);
    for (const c of apiCalls) expect(c.authorization).toBe("Bearer tok-1");
  });
});

// ─── 2. single-flight ─────────────────────────────────────────────────────────

describe("single-flight token fetch", () => {
  test("two concurrent requests trigger exactly one token fetch", async () => {
    const { sleep } = makeRecordedSleep();
    let tokenFetches = 0;
    const { fetchImpl, calls } = makeFetch({
      token: () => {
        tokenFetches++;
        return tokenResponse("tok-sf");
      },
      api: () => jsonResponse({ ok: true }),
    });
    const client = makeClient({ fetch: fetchImpl, sleep });

    await Promise.all([
      client.request({ path: "/items", method: "GET" }),
      client.request({ path: "/items", method: "GET" }),
    ]);

    expect(tokenFetches).toBe(1);
    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });
});

// ─── 3. 401 → refresh → retry once; second 401 → UnauthorizedError ────────────

describe("401 single-refresh", () => {
  test("401 invalidates cache, re-fetches token, retries once, succeeds", async () => {
    const { sleep } = makeRecordedSleep();
    const tokens = queue([tokenResponse("tok-old"), tokenResponse("tok-new")]);
    const apiResponses = queue([jsonResponse({}, 401), jsonResponse({ ok: true })]);
    const { fetchImpl, calls } = makeFetch({ token: tokens, api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    const res = await client.request({ path: "/items", method: "GET" });
    expect(res.status).toBe(200);

    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
    const apiCalls = calls.filter((c) => c.url !== TOKEN_URL);
    expect(apiCalls).toHaveLength(2);
    expect(apiCalls[0]!.authorization).toBe("Bearer tok-old");
    expect(apiCalls[1]!.authorization).toBe("Bearer tok-new");
  });

  test("second 401 throws UnauthorizedError", async () => {
    const { sleep } = makeRecordedSleep();
    const tokens = queue([tokenResponse("t1"), tokenResponse("t2")]);
    const apiResponses = queue([jsonResponse({}, 401), jsonResponse({}, 401)]);
    const { fetchImpl } = makeFetch({ token: tokens, api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    await expect(client.request({ path: "/items", method: "GET" })).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });
});

// ─── 4. env pickup ─────────────────────────────────────────────────────────────

describe("env pickup", () => {
  test("AGENTMIN_CLIENT_ID/SECRET resolve auth when no auth option is passed", async () => {
    vi.stubEnv("AGENTMIN_CLIENT_ID", "env-cid");
    vi.stubEnv("AGENTMIN_CLIENT_SECRET", "env-secret");
    const { sleep } = makeRecordedSleep();
    const { fetchImpl, calls } = makeFetch({
      token: () => tokenResponse("env-tok"),
      api: () => jsonResponse({ ok: true }),
    });
    // No `auth` option — must resolve from env.
    const client = new Client({ baseUrl: BASE_URL, fetch: fetchImpl, sleep });

    const res = await client.request({ path: "/items", method: "GET" });
    expect(res.status).toBe(200);
    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    expect(tokenCall.authorization).toBe(`Basic ${btoa("env-cid:env-secret")}`);
  });

  test("nothing set → ConfigError naming AGENTMIN_CLIENT_ID", () => {
    const { sleep } = makeRecordedSleep();
    const { fetchImpl } = makeFetch({ api: () => jsonResponse({}) });
    let caught: unknown = null;
    try {
      new Client({ baseUrl: BASE_URL, fetch: fetchImpl, sleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as ConfigError).message).toContain("AGENTMIN_CLIENT_ID");
  });
});

// ─── 5. Retry-After handling ─────────────────────────────────────────────────

describe("Retry-After", () => {
  test("429 with Retry-After: 1 → recorded sleep [1000], attempt 2 succeeds", async () => {
    const { sleep, delays } = makeRecordedSleep();
    const apiResponses = queue([
      jsonResponse({}, 429, { "Retry-After": "1" }),
      jsonResponse({ ok: true }),
    ]);
    const { fetchImpl } = makeFetch({ token: () => tokenResponse("t"), api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    const res = await client.request({ path: "/items", method: "GET" });
    expect(res.status).toBe(200);
    expect(delays).toEqual([1000]);
  });

  test("429 with unparseable Retry-After → falls back to computed backoff within jitter bounds", async () => {
    const { sleep, delays } = makeRecordedSleep();
    const apiResponses = queue([
      jsonResponse({}, 429, { "Retry-After": "garbage" }),
      jsonResponse({ ok: true }),
    ]);
    const { fetchImpl } = makeFetch({ token: () => tokenResponse("t"), api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    const res = await client.request({ path: "/items", method: "GET" });
    expect(res.status).toBe(200);
    expect(delays).toHaveLength(1);
    // attempt 0 backoff cap = min(30000, 500 * 2^0) = 500. Full jitter ∈ [0, 500).
    expect(delays[0]!).toBeGreaterThanOrEqual(0);
    expect(delays[0]!).toBeLessThan(500);
  });
});

// ─── 6. backoff + method-class retryability ──────────────────────────────────

describe("backoff and method-class retryability", () => {
  test("GET 500,500,200 → two backoff sleeps each within full-jitter bounds → success", async () => {
    const { sleep, delays } = makeRecordedSleep();
    const apiResponses = queue([
      jsonResponse({}, 500),
      jsonResponse({}, 500),
      jsonResponse({ ok: true }),
    ]);
    const { fetchImpl } = makeFetch({ token: () => tokenResponse("t"), api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    const res = await client.request({ path: "/items", method: "GET" });
    expect(res.status).toBe(200);
    expect(delays).toHaveLength(2);
    for (let n = 0; n < delays.length; n++) {
      const cap = Math.min(30000, 500 * 2 ** n);
      expect(delays[n]!).toBeGreaterThanOrEqual(0);
      expect(delays[n]!).toBeLessThan(cap);
    }
  });

  test("POST 500 → immediate throw, zero sleeps (non-idempotent never retries 500)", async () => {
    const { sleep, delays } = makeRecordedSleep();
    const apiResponses = queue([jsonResponse({ error: "boom" }, 500)]);
    const { fetchImpl } = makeFetch({ token: () => tokenResponse("t"), api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    await expect(
      client.request({ path: "/items", method: "POST", body: { name: "x" } }),
    ).rejects.toThrow();
    expect(delays).toEqual([]);
  });

  test("GET per-attempt timeout is retried (idempotent-timeout rule)", async () => {
    const { sleep, delays } = makeRecordedSleep();
    let apiCall = 0;
    // First attempt: simulate a per-attempt timeout by aborting via the signal.
    const fetchImpl = (async (input: Request | string | URL): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(String(input));
      if (req.url === TOKEN_URL) return tokenResponse("t");
      apiCall++;
      if (apiCall === 1) {
        // Emulate fetch rejecting because the abort signal fired (timeout).
        const signal = req.signal;
        const err = new DOMException("The operation was aborted.", "AbortError");
        // Mark the controller as aborted so runtime classifies it as a timeout.
        Object.defineProperty(signal, "aborted", { value: true, configurable: true });
        throw err;
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
    const client = makeClient({ fetch: fetchImpl, sleep, timeout: 50 });

    const res = await client.request({ path: "/items", method: "GET" });
    expect(res.status).toBe(200);
    expect(apiCall).toBe(2);
    expect(delays).toHaveLength(1);
  });
});

// ─── 7. cursor pagination via itemsPages ─────────────────────────────────────

describe("itemsPages cursor pagination", () => {
  test("3 pages then next_cursor: null → yields all items, fetch called 3×", async () => {
    const { sleep } = makeRecordedSleep();
    let page = 0;
    const pages = [
      { data: [{ id: "1" }, { id: "2" }], next_cursor: "c1" },
      { data: [{ id: "3" }, { id: "4" }], next_cursor: "c2" },
      { data: [{ id: "5" }], next_cursor: null },
    ];
    const { fetchImpl, calls } = makeFetch({
      token: () => tokenResponse("t"),
      api: () => jsonResponse(pages[page++]!),
    });
    const client = attachResources(makeClient({ fetch: fetchImpl, sleep }));

    const ids: string[] = [];
    for await (const item of client.items.listPages()) {
      ids.push((item as { id: string }).id);
    }
    expect(ids).toEqual(["1", "2", "3", "4", "5"]);
    expect(calls.filter((c) => c.url.startsWith(`${BASE_URL}/items`))).toHaveLength(3);
  });

  test("repeated-cursor page stops iteration cleanly (no infinite loop)", async () => {
    const { sleep } = makeRecordedSleep();
    // Always returns the same cursor — the engine must detect the repeat and stop.
    const { fetchImpl } = makeFetch({
      token: () => tokenResponse("t"),
      api: () => jsonResponse({ data: [{ id: "x" }], next_cursor: "stuck" }),
    });
    const client = attachResources(makeClient({ fetch: fetchImpl, sleep }));

    const run = async (): Promise<number> => {
      let count = 0;
      for await (const _ of client.items.listPages()) {
        count++;
        if (count > 100) throw new Error("iteration did not stop on repeated cursor");
      }
      return count;
    };
    // Timeout guard: if it loops forever the Promise.race rejects.
    const guard = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("itemsPages hung")), 2000).unref?.(),
    );
    const count = await Promise.race([run(), guard]);
    // First page (cursor undefined → "stuck"), second page repeats "stuck" → stop.
    expect(count).toBe(2);
  });
});

// ─── 8. tokenProvider ─────────────────────────────────────────────────────────

describe("tokenProvider auth", () => {
  test("getToken is called and its Bearer is applied to the API call", async () => {
    const { sleep } = makeRecordedSleep();
    const getToken = vi.fn(async () => "provided-token");
    const { fetchImpl, calls } = makeFetch({ api: () => jsonResponse({ ok: true }) });
    const client = new Client({
      baseUrl: BASE_URL,
      auth: { kind: "tokenProvider", getToken },
      fetch: fetchImpl,
      sleep,
    });

    await client.request({ path: "/items", method: "GET" });
    expect(getToken).toHaveBeenCalledTimes(1);
    const apiCall = calls.find((c) => c.url !== TOKEN_URL)!;
    expect(apiCall.authorization).toBe("Bearer provided-token");
  });
});

// ─── 9. status-exhaustion attempt-count suffix ──────────────────────────────

describe("status-exhaustion attempt-count suffix", () => {
  test("GET 500×(MAX_RETRIES+1) throws typed 5xx error with (after 3 attempts) suffix", async () => {
    // MAX_RETRIES=2 default → loop runs attempts 0,1,2 → 3 total fetches, all 500.
    const { sleep } = makeRecordedSleep();
    const apiResponses = queue([
      jsonResponse({ error: "internal" }, 500),
      jsonResponse({ error: "internal" }, 500),
      jsonResponse({ error: "internal" }, 500),
    ]);
    const { fetchImpl } = makeFetch({ token: () => tokenResponse("t"), api: apiResponses });
    const client = makeClient({ fetch: fetchImpl, sleep });

    let thrown: unknown = null;
    try {
      await client.request({ path: "/items", method: "GET" });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    // Must be the typed 5xx error class, not a bare Error.
    const { InternalServerError } = await import(
      "../fixtures/golden/sdk-agent-minimal/src/errors.js"
    );
    expect(thrown).toBeInstanceOf(InternalServerError);
    // The contract: exhausted status path must append the suffix.
    expect((thrown as Error).message).toMatch(/after 3 attempts/);
  });
});
