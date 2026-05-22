// L2 runtime smoke: build the emitted SDK exactly as a consumer would
// (tsc -> dist), import the built package, and exercise the wedge invariant
// (auth injection, status->typed-error mapping, path-param substitution,
// timeout->TimeoutError) plus C1 public-surface reachability against a live
// HTTP server. Network-gated: only runs with SKILLSHIP_NETWORK_SMOKE=1.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const NETWORK = process.env.SKILLSHIP_NETWORK_SMOKE === "1";
const BASE = process.env.SKILLSHIP_HTTPBIN_URL ?? "https://httpbin.org";

type ErrCtor = abstract new (...args: never[]) => Error;

interface ClientInstance {
  request: (input: {
    path: string;
    method: string;
    pathParams?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
  }) => Promise<Response>;
}

interface ClientCtor {
  new (opts: {
    baseUrl: string;
    auth: { kind: "bearer"; token: string };
    timeout?: number;
  }): ClientInstance;
}

interface SdkModule {
  Client: ClientCtor;
  attachResources: (c: ClientInstance) => ClientInstance;
  NotFoundError: ErrCtor;
  TimeoutError: ErrCtor;
  APIError: ErrCtor;
}

function statusOf(err: unknown): number | undefined {
  return (err as { status?: number }).status;
}

async function capture(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e;
  }
}

describe.skipIf(!NETWORK)("SDK runtime smoke (httpbin)", () => {
  let tmp = "";
  let mod: SdkModule;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "sk-sdk-rt-"));
    cpSync(join(process.cwd(), "tests/fixtures/golden/sdk-minimal"), tmp, {
      recursive: true,
    });
    const tscBin = join(process.cwd(), "node_modules", ".bin", "tsc");
    execFileSync(tscBin, ["-p", tmp], { stdio: "pipe" });
    const url = pathToFileURL(join(tmp, "dist/index.js")).href;
    mod = (await import(url)) as unknown as SdkModule;
  }, 60000);

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function newClient(timeout?: number): ClientInstance {
    return new mod.Client({
      baseUrl: BASE,
      auth: { kind: "bearer", token: "smoke-token-123" },
      ...(timeout !== undefined ? { timeout } : {}),
    });
  }

  test("injects bearer Authorization header", async () => {
    const res = await newClient().request({ method: "GET", path: "/bearer" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean; token: string };
    expect(body.authenticated).toBe(true);
    expect(body.token).toBe("smoke-token-123");
  });

  test("maps 404 response to NotFoundError with status", async () => {
    const err = await capture(
      newClient().request({ method: "GET", path: "/status/404" }),
    );
    expect(err).toBeInstanceOf(mod.NotFoundError);
    expect(statusOf(err)).toBe(404);
  });

  test("substitutes path parameters before sending", async () => {
    const res = await newClient().request({
      method: "GET",
      path: "/anything/{id}",
      pathParams: { id: "42" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toContain("/anything/42");
    expect(body.url).not.toContain("{id}");
  });

  test("aborts a slow request as TimeoutError", async () => {
    const err = await capture(
      newClient(500).request({ method: "GET", path: "/delay/5" }),
    );
    expect(err).toBeInstanceOf(mod.TimeoutError);
  }, 15000);

  test("public surface reaches network through Client.request (C1)", async () => {
    const client = mod.attachResources(newClient());
    const projects = (
      client as unknown as {
        projects: Record<string, () => Promise<Response>>;
      }
    ).projects;
    const methodNames = Object.keys(projects);
    expect(methodNames.length).toBeGreaterThan(0);
    // httpbin has no /projects -> 404; reaching that proves the namespace
    // method routed through Client.request (auth + error mapping fired),
    // i.e. the wedge is reachable from the package entry, not bypassed.
    const err = await capture(projects[methodNames[0]]());
    expect(err).toBeInstanceOf(mod.NotFoundError);
  });
});
