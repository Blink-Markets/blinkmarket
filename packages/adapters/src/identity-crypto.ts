import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { recoverMessageAddress, type Hex } from "viem";
import type { IdentityCrypto } from "@blink/ports";

export const identityCrypto: IdentityCrypto = {
  id: randomUUID,
  nonce: () => randomBytes(32).toString("hex"),
  hash: (value) => createHash("sha256").update(value, "utf8").digest("hex"),
  equalHash(a, b) {
    if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  },
  async verifyMessage(address, message, signature) {
    try {
      return (
        (
          await recoverMessageAddress({ message, signature: signature as Hex })
        ).toLowerCase() === address.toLowerCase()
      );
    } catch {
      return false;
    }
  },
};
