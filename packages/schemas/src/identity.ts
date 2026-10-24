import { z } from "zod";
import { Address } from "./core.ts";

// What a self-serve API key can hold. Nothing here is operator-only.
export const ApiScope = z.enum([
  "forecast:write",
  "rfq:write",
  "content:write",
  "suggestion:claim",
]);
export type ApiScope = z.infer<typeof ApiScope>;
export const WalletProofAction = z.enum(["issue", "revoke"]);
export const WalletChallengeRequest = z
  .strictObject({
    address: Address,
    action: WalletProofAction,
    keyId: z.uuid().optional(),
  })
  .refine(
    (v) => (v.action === "revoke") === (v.keyId !== undefined),
    "keyId is required for revoke and refused for issue",
  );
export const WalletChallengeResponse = z.strictObject({
  challengeId: z.uuid(),
  message: z.string().min(1).max(4000),
  expiresAt: z.iso.datetime(),
});
// A contract wallet signature is not always 65 bytes (multisig, ERC-6492 wrapper), so any even-length hex up to 8 KiB.
export const WalletVerificationRequest = z.strictObject({
  challengeId: z.uuid(),
  signature: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){1,8192}$/),
});
export const WalletVerificationResponse = z.union([
  z.strictObject({
    apiKey: z.string().min(1),
    keyId: z.uuid(),
    expiresAt: z.iso.datetime(),
  }),
  z.strictObject({ keyId: z.uuid(), revokedAt: z.iso.datetime() }),
]);
