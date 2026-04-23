import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface CannedResponse {
  status: number;
  contentType: string;
  body: string | Buffer;
}

export type RouteMap = Record<string, CannedResponse>;

export interface TestServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

function makeHandler(
  routes: RouteMap,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const path = req.url ?? "/";
    const entry = routes[path];
    if (!entry) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      res.end("not found");
      return;
    }
    res.statusCode = entry.status;
    res.setHeader("Content-Type", entry.contentType);
    res.end(entry.body);
  };
}

export async function startTestServer(routes: RouteMap): Promise<TestServer> {
  const server: Server = createServer(makeHandler(routes));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    port: addr.port,
    close: (): Promise<void> =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
