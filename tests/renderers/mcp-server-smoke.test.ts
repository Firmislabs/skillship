// tests/renderers/mcp-server-smoke.test.ts
// Smoke suite: spawns the committed golden's bin/mcp.js as a real child process
// and drives a minimal JSON-RPC conversation over stdio. No network — only
// initialize + tools/list, no invoke. Guard skips below Node 23.6 (strip floor).
import { describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ─── version guard ────────────────────────────────────────────────────────────

const BELOW_STRIP_FLOOR = (() => {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major < 23 || (major === 23 && minor < 6);
})();

// ─── helpers ──────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MCP_BIN = resolve(
  __dirname,
  "../../tests/fixtures/golden/sdk-agent-minimal/bin/mcp.js",
);

function writeLine(writer: NodeJS.WritableStream, obj: unknown): void {
  writer.write(JSON.stringify(obj) + "\n");
}

/**
 * Reads newline-delimited JSON from the child's stdout, collecting exactly
 * `count` non-empty JSON objects, then resolves.
 */
function readJsonLines(
  readable: NodeJS.ReadableStream,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const results: Array<Record<string, unknown>> = [];
    let buffer = "";
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.length === 0) continue;
        try {
          results.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          reject(new Error(`failed to parse JSON line: ${line}`));
          return;
        }
        if (results.length >= count) {
          resolve(results);
          return;
        }
      }
    });
    readable.on("end", () => {
      if (results.length < count) {
        reject(
          new Error(
            `stream ended with only ${results.length}/${count} responses`,
          ),
        );
      }
    });
    readable.on("error", reject);
  });
}

// ─── smoke test ───────────────────────────────────────────────────────────────

describe.skipIf(BELOW_STRIP_FLOOR)("mcp.js stdio smoke", () => {
  test(
    "spawns, responds to initialize + tools/list, exits 0",
    async () => {
      const child = spawn("node", [MCP_BIN], {
        stdio: ["pipe", "pipe", "pipe"],
        // No AGENTMIN_* env — smoke does not invoke, so auth is not needed.
        env: { ...process.env, AGENTMIN_CLIENT_ID: undefined, AGENTMIN_CLIENT_SECRET: undefined },
      });

      // Collect stderr for diagnostics if the test fails.
      const stderrLines: string[] = [];
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (d: string) => stderrLines.push(d));

      // We expect exactly 2 responses: one for initialize, one for tools/list.
      const responsesPromise = readJsonLines(child.stdout!, 2);

      // Write initialize
      writeLine(child.stdin!, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "0.0.0" },
        },
      });

      // notifications/initialized — no id, no response expected
      writeLine(child.stdin!, {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      });

      // Write tools/list
      writeLine(child.stdin!, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });

      // Close stdin → triggers graceful exit after processing buffered input
      child.stdin!.end();

      // Wait for the two responses (30s timeout set via vitest test timeout below)
      let responses: Array<Record<string, unknown>>;
      try {
        responses = await responsesPromise;
      } catch (err) {
        const stderr = stderrLines.join("");
        throw new Error(
          `response read failed: ${String(err)}\nstderr:\n${stderr}`,
        );
      }

      // ── assert initialize response ──────────────────────────────────────────
      const initRes = responses[0]!;
      expect(initRes.id).toBe(1);
      const initResult = initRes.result as Record<string, unknown>;
      expect(initResult.protocolVersion).toBe("2025-06-18");
      const serverInfo = initResult.serverInfo as Record<string, unknown>;
      expect(serverInfo.name).toBe("agentmin-mcp");
      expect(serverInfo.version).toBe("0.1.0");

      // ── assert tools/list response ──────────────────────────────────────────
      const toolsRes = responses[1]!;
      expect(toolsRes.id).toBe(2);
      const toolsResult = toolsRes.result as { tools: Array<{ name: string }> };
      const toolNames = toolsResult.tools.map((t) => t.name);
      expect(toolNames).toContain("search_operations");
      expect(toolNames).toContain("describe_operation");
      expect(toolNames).toContain("invoke_operation");

      // ── wait for clean exit ─────────────────────────────────────────────────
      const exitCode = await new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
        // If the child already exited before we listen:
        if (child.exitCode !== null) resolve(child.exitCode);
      });

      if (exitCode !== 0) {
        const stderr = stderrLines.join("");
        throw new Error(`mcp.js exited with code ${exitCode}\nstderr:\n${stderr}`);
      }
      expect(exitCode).toBe(0);
    },
    30_000, // 30s timeout for the process
  );
});

describe.skipIf(!BELOW_STRIP_FLOOR)("mcp.js smoke (skipped: below Node 23.6)", () => {
  test("skip placeholder", () => {
    // This suite intentionally skips on Node <23.6 because bin/mcp.js requires
    // native TypeScript stripping (Node >=23.6). Current Node: " + process.versions.node
    expect(true).toBe(true);
  });
});
