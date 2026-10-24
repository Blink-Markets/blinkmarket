import {
  createPublicClient,
  encodeDeployData,
  erc6492SignatureValidatorAbi,
  erc6492SignatureValidatorByteCode,
  ExecutionRevertedError,
  hashMessage,
  hashTypedData,
  hexToBigInt,
  hexToBool,
  http,
  isErc6492Signature,
  isHex,
  size,
  slice,
  type Hex,
  type PublicClient,
} from "viem";
import {
  SignatureCheckUnavailable,
  type SignatureCheck,
  type SignatureVerifier,
} from "@blink/ports";

// secp256k1 n / 2: OpenZeppelin ECDSA.tryRecover rejects any larger s.
const HALF_CURVE_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// What OpenZeppelin ECDSA.tryRecover accepts, so an off-chain "valid" never disagrees with
// BlinkMarkets.fillQuote for an EOA: 65 bytes, low s, v of 27 or 28. viem would also recover
// from high-s and 0/1-v encodings.
function isCanonicalEcdsa(signature: Hex): boolean {
  if (!isHex(signature, { strict: true }) || size(signature) !== 65)
    return false;
  const v = hexToBigInt(slice(signature, 64, 65));
  return (
    (v === 27n || v === 28n) &&
    hexToBigInt(slice(signature, 32, 64)) <= HALF_CURVE_ORDER
  );
}

type Client = Pick<PublicClient, "getBlockNumber" | "getCode" | "call">;

// Only viem's mapping of the node's "execution reverted" answer counts as a rejection. Error data
// alone is not evidence: an RPC internal error can carry data too.
function isRevert(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof ExecutionRevertedError) return true;
  return "cause" in error && isRevert(error.cause);
}

/**
 * One check for EOA, ERC-1271 and ERC-6492, pinned to the head block read first so the caller
 * knows which state answered. Any RPC failure becomes SignatureCheckUnavailable.
 */
export function viemSignatureVerifier(client: Client): SignatureVerifier {
  async function check(
    address: Hex,
    signature: Hex,
    hash: () => Hex,
  ): Promise<SignatureCheck> {
    try {
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      if (!isHex(signature, { strict: true }))
        return { valid: false, blockNumber };
      if (!isErc6492Signature(signature)) {
        const code = await client.getCode({ address, blockNumber });
        if (!code || code === "0x") {
          if (!isCanonicalEcdsa(signature))
            return { valid: false, blockNumber };
        }
      }
      const data = encodeDeployData({
        abi: erc6492SignatureValidatorAbi,
        bytecode: erc6492SignatureValidatorByteCode,
        args: [address, hash(), signature],
      });
      try {
        // Call viem's validator directly: verifyHash also turns RPC failures into false.
        const result = await client.call({ data, blockNumber });
        return { valid: hexToBool(result.data ?? "0x0"), blockNumber };
      } catch (cause) {
        if (isRevert(cause)) return { valid: false, blockNumber };
        throw cause;
      }
    } catch (cause) {
      throw new SignatureCheckUnavailable(undefined, { cause });
    }
  }
  return {
    verifyMessage: ({ address, message, signature }) =>
      check(address as Hex, signature, () => hashMessage(message)),
    verifyTypedData: ({ address, typedData, signature }) =>
      check(address as Hex, signature, () =>
        hashTypedData(typedData as Parameters<typeof hashTypedData>[0]),
      ),
  };
}

const noRpc = async (): Promise<never> => {
  throw new SignatureCheckUnavailable("RPC_NOT_CONFIGURED");
};

/** The verifier over a plain JSON-RPC endpoint. Without an endpoint every check is unavailable. */
export const rpcSignatureVerifier = (
  rpcUrl: string | undefined,
): SignatureVerifier =>
  rpcUrl
    ? viemSignatureVerifier(createPublicClient({ transport: http(rpcUrl) }))
    : { verifyMessage: noRpc, verifyTypedData: noRpc };
