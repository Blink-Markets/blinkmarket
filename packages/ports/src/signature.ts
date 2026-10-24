import type { Address } from "@blink/schemas";

// ports may not depend on viem, so the viem shapes are restated structurally. Hex stays private so
// it cannot collide with other port modules (or vanish with them).
type Hex = `0x${string}`;
export type TypedDataDefinition = {
  domain: Record<string, unknown>;
  types: Record<string, readonly { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** `blockNumber` is the block the check ran at. */
export type SignatureCheck = { valid: boolean; blockNumber: bigint };

/**
 * The only off-chain signature check: EOA, ERC-1271 contract wallets and ERC-6492 wrapped
 * signatures of undeployed wallets. No caller recovers an address on its own.
 */
export interface SignatureVerifier {
  verifyMessage(input: {
    address: Address;
    message: string;
    signature: Hex;
  }): Promise<SignatureCheck>;
  verifyTypedData(input: {
    address: Address;
    typedData: TypedDataDefinition;
    signature: Hex;
  }): Promise<SignatureCheck>;
}

/** The chain could not answer; callers respond 503 SIGNATURE_CHECK_UNAVAILABLE. */
export class SignatureCheckUnavailable extends Error {
  constructor(message = "SIGNATURE_CHECK_UNAVAILABLE", options?: ErrorOptions) {
    super(message, options);
    this.name = "SignatureCheckUnavailable";
  }
}
