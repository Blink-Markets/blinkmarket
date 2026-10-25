import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseTransaction, type Hex } from "viem";

const LATE_MS = 1500;

export type SendFault = (tx: { to: string | undefined; data: Hex | undefined }) => 
  | "pass"
  | "swallow" // never reaches the node, the caller sees a failure
  | "lose-answer" // reaches the node (and is mined), the caller sees a failure
  | "lose-answer-later" // the caller sees a failure now; the node gets the transaction a moment later
  | Promise<"pass" | "swallow" | "lose-answer" | "lose-answer-later">;

/**
 * A loopback JSON-RPC proxy in front of Anvil that can make a transaction send fail the way a
 * flaky network does. Everything but eth_sendRawTransaction is forwarded untouched.
 */
export async function rpcFaultProxy(nodeUrl: string, onSend: SendFault) {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (c) => chunks.push(c));
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const call = JSON.parse(body) as { method: string; params?: string[] };
      let verdict: Awaited<ReturnType<SendFault>> = "pass";
      if (call.method === "eth_sendRawTransaction") {
        const tx = parseTransaction(call.params![0] as Hex);
        verdict = await onSend({ to: tx.to ?? undefined, data: tx.data });
      }
      if (verdict === "swallow") return void response.destroy();
      if (verdict === "lose-answer-later") {
        response.destroy();
        await new Promise((r) => setTimeout(r, LATE_MS));
      }
      const upstream = await fetch(nodeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      const answer = await upstream.text();
      if (verdict === "lose-answer") return void response.destroy();
      if (verdict === "lose-answer-later") return;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(answer);
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
