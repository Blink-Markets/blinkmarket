import { keccak256 } from "viem";

/** keccak256 of bytes as lowercase 0x hex: the hash evidence, prompts and objects use. */
export const keccak256Hex = (bytes: Uint8Array): string => keccak256(bytes);
