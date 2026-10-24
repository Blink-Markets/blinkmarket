import {
  hexToBigInt,
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

type Client = Pick<
  PublicClient,
  "getBlockNumber" | "getCode" | "verifyMessage" | "verifyTypedData"
>;

/**
 * One check for EOA, ERC-1271 and ERC-6492, pinned to the head block read first so the caller
 * knows which state answered. Any RPC failure becomes SignatureCheckUnavailable.
 */
export function viemSignatureVerifier(client: Client): SignatureVerifier {
  async function check(
    address: Hex,
    signature: Hex,
    verify: (blockNumber: bigint) => Promise<boolean>,
  ): Promise<SignatureCheck> {
    try {
      const blockNumber = await client.getBlockNumber();
      if (!isHex(signature, { strict: true }))
        return { valid: false, blockNumber };
      if (!isErc6492Signature(signature)) {
        const code = await client.getCode({ address, blockNumber });
        if (!code || code === "0x") {
          if (!isCanonicalEcdsa(signature))
            return { valid: false, blockNumber };
        }
      }
      return { valid: await verify(blockNumber), blockNumber };
    } catch (cause) {
      throw new SignatureCheckUnavailable(undefined, { cause });
    }
  }
  return {
    verifyMessage: ({ address, message, signature }) =>
      check(address as Hex, signature, (blockNumber) =>
        client.verifyMessage({
          address: address as Hex,
          message,
          signature,
          blockNumber,
        }),
      ),
    verifyTypedData: ({ address, typedData, signature }) =>
      check(address as Hex, signature, (blockNumber) =>
        client.verifyTypedData({
          ...typedData,
          address: address as Hex,
          signature,
          blockNumber,
        } as Parameters<Client["verifyTypedData"]>[0]),
      ),
  };
}
