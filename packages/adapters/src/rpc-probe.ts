import type { RpcProbe } from "@blink/ports";

const PROBE_TIMEOUT_MS = 5000;

/**
 * eth_chainId then eth_blockNumber against the configured RPC. Failures are reported only as fixed
 * codes: the URL (it may carry a provider key) and any response text never leave this function.
 */
export function httpRpcProbe(
  url: string,
  options: { expectedChainId?: number; timeoutMs?: number } = {},
): RpcProbe {
  const expectedChainId = options.expectedChainId ?? 84532;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return {
    async probe(signal) {
      const timeout = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const call = async (id: number, method: string): Promise<unknown> => {
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
          signal: timeout,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error("RPC_UNREACHABLE");
        }
        const body: unknown = await response.json().catch(() => {
          throw new Error("RPC_BAD_RESPONSE");
        });
        const result = (body as { result?: unknown } | null)?.result;
        if (typeof result !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(result))
          throw new Error("RPC_BAD_RESPONSE");
        return result;
      };
      try {
        const chainId = await call(1, "eth_chainId");
        const seen = BigInt(chainId as string);
        // The worker must never talk to mainnet: say so, rather than a generic wrong chain.
        if (seen === 8453n) return { ok: false, reason: "MAINNET_REFUSED" };
        if (seen !== BigInt(expectedChainId))
          return { ok: false, reason: "RPC_WRONG_CHAIN" };
        await call(2, "eth_blockNumber");
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          reason:
            error instanceof Error && error.message === "RPC_BAD_RESPONSE"
              ? "RPC_BAD_RESPONSE"
              : "RPC_UNREACHABLE",
        };
      }
    },
  };
}
