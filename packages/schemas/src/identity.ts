import { z } from "zod";
import { Address } from "./core.ts";

export const ApiScope = z.enum([
  "candidate:write",
  "forecast:write",
  "trade:quote",
  "report:write",
  "faucet:claim",
  "admin",
]);
export type ApiScope = z.infer<typeof ApiScope>;
export const IdentityInvitation = z.strictObject({
  operatorName: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(200),
  scopes: z.array(ApiScope).min(1).max(6),
  lifetimeDays: z.number().int().min(1).max(30).default(30),
  reason: z.string().trim().min(1).max(2000),
});
export const WalletChallengeRequest = z.strictObject({ address: Address });
export const WalletChallengeResponse = z.strictObject({
  challengeId: z.uuid(),
  message: z.string().min(1).max(4000),
  expiresAt: z.iso.datetime(),
});
export const WalletVerificationRequest = z.strictObject({
  challengeId: z.uuid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const WalletVerificationResponse = z.strictObject({
  wallet: Address,
  verifiedAt: z.iso.datetime(),
});
