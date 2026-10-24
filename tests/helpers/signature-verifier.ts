import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import {
  SignatureCheckUnavailable,
  type SignatureVerifier,
} from "../../packages/ports/src/index.ts";
import type { Address } from "../../packages/schemas/src/index.ts";

/**
 * Local stand-in for viemSignatureVerifier. An EOA is checked by recovery; a listed contract wallet
 * (`contractWallets[wallet] = owner`) accepts its owner's signature, like the ERC-1271 mock. Recovery
 * is allowed here because this is a test fake; platform code goes through SignatureVerifier.
 */
export function fakeSignatureVerifier(
  opts: { contractWallets?: Record<Address, Address> } = {},
): SignatureVerifier & { setUnavailable(on: boolean): void } {
  let unavailable = false;
  const wallets = new Map(
    Object.entries(opts.contractWallets ?? {}).map(([w, o]) => [
      w.toLowerCase(),
      o.toLowerCase(),
    ]),
  );
  const blockNumber = 1n;
  const check = async (address: Address, recover: () => Promise<string>) => {
    if (unavailable) throw new SignatureCheckUnavailable();
    const expected =
      wallets.get(address.toLowerCase()) ?? address.toLowerCase();
    try {
      return {
        valid: (await recover()).toLowerCase() === expected,
        blockNumber,
      };
    } catch {
      return { valid: false, blockNumber };
    }
  };
  return {
    setUnavailable(on) {
      unavailable = on;
    },
    verifyMessage: ({ address, message, signature }) =>
      check(address, () => recoverMessageAddress({ message, signature })),
    verifyTypedData: ({ address, typedData, signature }) =>
      check(address, () =>
        recoverTypedDataAddress({
          ...(typedData as Parameters<typeof recoverTypedDataAddress>[0]),
          signature,
        }),
      ),
  };
}
