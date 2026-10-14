import { parseAbi, type PublicClient } from "viem";

// Base (OP Stack) predeploy. Anvil has none, which is why a loopback RPC may run with
// l1FeeMode "local-none"; any other RPC must use the oracle.
export const baseGasPriceOracle =
  "0x420000000000000000000000000000000000000F" as const;
const oracleAbi = parseAbi([
  "function getL1Fee(bytes _data) view returns (uint256)",
]);

export async function oracleL1Fee(
  client: Pick<PublicClient, "readContract">,
  serializedUnsigned: `0x${string}`,
): Promise<bigint> {
  return client.readContract({
    address: baseGasPriceOracle,
    abi: oracleAbi,
    functionName: "getL1Fee",
    args: [serializedUnsigned],
  });
}

/** True only for a literal loopback host (localhost, 127.0.0.0/8, ::1). */
export function isLoopbackUrl(rpcUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)
  );
}
