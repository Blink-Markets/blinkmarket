import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RfqStack } from "./rfq-stack.ts";

/**
 * The read routes of Task 7 (`/v1/deployment`, `/v1/markets`, `/v1/markets/:id`) are not part of
 * this branch's API. This front forwards every request to the real API and, only when the API
 * itself refuses (no such route, or the retired v0.1 route of the same path), answers from the
 * same indexed state the real routes would read. Rerun this suite against the API with Task 7 merged: the shim then
 * never fires (`shimmed` stays empty), which the test reports.
 */
export async function frontWithReadShim(stack: RfqStack, shimmed: Set<string>) {
  const index = () => stack.publicReader.health();
  const shim = async (path: string, query: URLSearchParams): Promise<unknown | undefined> => {
    if (path === "/v1/deployment") return { ...stack.d, index: await index() };
    if (path === "/v1/markets") {
      const state = query.get("state");
      const page = await stack.publicReader.markets({
        ...(state ? { states: [state as never] } : {}),
        limit: 100,
      });
      return { ...page, index: await index() };
    }
    const one = /^\/v1\/markets\/([0-9]+)$/.exec(path);
    if (one) {
      const market = await stack.publicReader.market(one[1]!);
      return market ? { ...market, index: await index() } : undefined;
    }
    return undefined;
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", async () => {
      try {
        const url = new URL(request.url!, "http://127.0.0.1");
        const headers = new Headers();
        for (const [k, v] of Object.entries(request.headers))
          if (typeof v === "string" && k !== "host" && k !== "content-length") headers.set(k, v);
        const body = Buffer.concat(chunks);
        const upstream = await fetch(stack.apiUrl + request.url, {
          method: request.method!,
          headers,
          ...(body.length ? { body } : {}),
        });
        const bytes = Buffer.from(await upstream.arrayBuffer());
        let answer: unknown;
        if (upstream.status >= 400 && request.method === "GET") {
          const parsed = JSON.parse(bytes.toString("utf8") || "{}") as { code?: string };
          // No such route, or the retired v0.1 route of the same path rejecting a request made for the new one.
          if (parsed.code === "NOT_FOUND" || parsed.code === "INVALID_REQUEST") {
            answer = await shim(url.pathname, url.searchParams);
            if (answer !== undefined) shimmed.add(url.pathname.replace(/[0-9]+$/, ":id"));
          }
        }
        if (answer !== undefined) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(answer));
          return;
        }
        response.writeHead(upstream.status, {
          "Content-Type": upstream.headers.get("content-type") ?? "application/json",
        });
        response.end(bytes);
      } catch (error) {
        response.writeHead(502);
        response.end(String(error));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

