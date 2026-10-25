export type EventValue =
  string | boolean | EventValue[] | { [key: string]: EventValue };
export interface ProtocolEvent {
  contract:
    | "REGISTRY"
    | "JURORS"
    | "MARKETS"
    | "RESOLUTION"
    | "FAUCET"
    | "ANCHOR"
    | "GOVERNOR";
  emitter: string;
  name: string;
  args: Record<string, EventValue>;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  txHash: string;
  txIndex: number;
  logIndex: number;
}
export class ChainProjectionError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ChainProjectionError";
  }
}
// Strict readers of decoded event arguments: any malformed value is a projection error.
export const fail = (e: ProtocolEvent, detail: string): never => {
  throw new ChainProjectionError(
    `${e.contract}.${e.name} at ${e.blockNumber}:${e.logIndex}: ${detail}`,
  );
};
export const str = (e: ProtocolEvent, k: string) => {
  const v = e.args[k];
  return typeof v === "string" ? v : fail(e, `invalid ${k}`);
};
export const uint = (e: ProtocolEvent, k: string) => {
  const v = str(e, k);
  return /^\d+$/.test(v) ? BigInt(v) : fail(e, `invalid uint ${k}`);
};
export const num = (e: ProtocolEvent, k: string) => {
  const n = uint(e, k);
  return n <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(n)
    : fail(e, `unsafe integer ${k}`);
};
export const hex = (e: ProtocolEvent, k: string, size: number) => {
  const v = str(e, k).toLowerCase();
  return new RegExp(`^0x[0-9a-f]{${size * 2}}$`).test(v)
    ? v
    : fail(e, `invalid hex ${k}`);
};
export const addr = (e: ProtocolEvent, k: string) => hex(e, k, 20);
export const hash = (e: ProtocolEvent, k: string) => hex(e, k, 32);
export const flag = (e: ProtocolEvent, k: string) => {
  const v = e.args[k];
  return typeof v === "boolean" ? v : fail(e, `invalid bool ${k}`);
};
export const member = <T extends string>(
  e: ProtocolEvent,
  k: string,
  values: readonly T[],
) => values[num(e, k)] ?? fail(e, `invalid enum ${k}`);
export const add = (value: string, delta: bigint, e: ProtocolEvent) => {
  const n = BigInt(value) + delta;
  return n >= 0n ? n.toString() : fail(e, "negative balance");
};
