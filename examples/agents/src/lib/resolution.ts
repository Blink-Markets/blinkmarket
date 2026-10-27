// What the resolution roles (proposer, challenger, juror, keeper) share: chain time, the market
// lists of the API, evidence bytes, bonds and a transaction that may lose a race. The wallet,
// registration and API key are the runtime's (`onboard`).
import { BaseError, ContractFunctionRevertedError, type Hex } from "viem";
import { BlinkApiError, ROLE, agentAbi } from "@blink/client";
import type { AgentContext, BlinkClient } from "./env.ts";
import type { MarketView } from "./model.ts";
import { send } from "./session.ts";

/** One market of `listMarkets`: the indexed market and the parse of its spec bytes. */
export type MarketItem = Awaited<ReturnType<BlinkClient["listMarkets"]>>["items"][number];
export type MarketState = NonNullable<NonNullable<Parameters<BlinkClient["listMarkets"]>[0]>["state"]>;

/** BlinkMarkets.UNIT: one share pays one bUSD, so a market's maximum payout is maxPairs times this. */
const UNIT = 1_000_000n;
const BPS = 10_000n;
const PAGE = 100;
// ponytail: 10 pages of 100 per state per tick; an index with more markets in one state needs a cursor kept in state.
const MAX_PAGES = 10;

export const actedOn = (ctx: AgentContext, action: string) => (ctx.state.data.acted[action] ??= []);

/** Chain time, never this machine's clock: every deadline of the protocol is a block timestamp. */
export async function chainSeconds(ctx: AgentContext): Promise<number> {
  return Number((await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp);
}

/** Every market of a state, page by page. */
export async function listAll(ctx: AgentContext, state: MarketState): Promise<MarketItem[]> {
  const items: MarketItem[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await ctx.client.listMarkets({ state, limit: PAGE, ...(after ? { after } : {}) });
    items.push(...answer.items);
    if (answer.next === null) break;
    after = answer.next;
  }
  return items;
}

/** What the model is asked about; null when the spec bytes cannot be read, which no one can judge. */
export function viewOf(item: Pick<MarketItem, "market" | "spec">): MarketView | null {
  return item.spec.ok
    ? { marketId: BigInt(item.market.marketId), specHash: item.market.specHash as Hex, spec: item.spec.spec }
    : null;
}

/**
 * True when the bytes of `hash` can be fetched from `/v1/content` and match it. The archived-bytes
 * rule: a proposal whose evidence cannot be fetched is unsupported. Only a refusal that means
 * "no such bytes" counts; a rate limit or a stale index propagates, so the loop backs off.
 */
export async function evidenceAvailable(ctx: AgentContext, hash: string): Promise<boolean> {
  try {
    await ctx.client.getContent(hash);
    return true;
  } catch (error) {
    if (error instanceof BlinkApiError && error.status === 404) return false;
    if (error instanceof Error && error.message === "HASH_MISMATCH") return false;
    // The API answers damaged bytes with a code the client's schema does not list; the client then
    // fails to parse the refusal. Bytes that cannot be served are as good as missing.
    if (error instanceof Error && error.name === "ZodError") return false;
    throw error;
  }
}

/** Uploads evidence bytes and returns their keccak256, which is also their address in the store. */
export async function uploadEvidence(ctx: AgentContext, bytes: Uint8Array): Promise<Hex> {
  return (await ctx.client.uploadContent(bytes, "text/plain")).hash as Hex;
}

export const resolutionAddress = (ctx: AgentContext) => ctx.deployment.generation.resolution as Hex;

/** The dispute and the round it is in (`currentRound`), read from the chain. */
export async function readDispute(ctx: AgentContext, disputeId: bigint) {
  const [dispute, round] = await ctx.publicClient.readContract({
    address: resolutionAddress(ctx),
    abi: agentAbi.resolution,
    functionName: "getDispute",
    args: [disputeId],
  });
  return { dispute, round };
}

/** What BlinkResolution takes as a bond: bondBps of the market's maximum payout, less this account's credit discount. */
export async function bondOf(
  ctx: AgentContext,
  role: (typeof ROLE)[keyof typeof ROLE],
  bondBps: number,
  maxPairs: string,
): Promise<bigint> {
  return ctx.publicClient.readContract({
    address: ctx.deployment.generation.registry as Hex,
    abi: agentAbi.registry,
    functionName: "bondFor",
    args: [ctx.account.address, role, (BigInt(maxPairs) * UNIT * BigInt(bondBps)) / BPS],
  });
}

/** Approves exactly `amount` of bUSD to the resolution contract, never more. */
export async function approveBond(ctx: AgentContext, amount: bigint) {
  await send(ctx, "APPROVE_BOND", {
    address: ctx.deployment.shared.busd as Hex,
    abi: agentAbi.usd,
    functionName: "approve",
    args: [resolutionAddress(ctx), amount],
  });
}

const nameOf = (error: unknown): string | undefined => {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
};

/**
 * The custom error a failed call reverted with, by name. A call the node refuses before it is sent
 * carries the error; a transaction that was mined and reverted (`<WHAT>_REVERTED`) is replayed
 * against the current state, which has since moved on but gives the same refusal for a lost race.
 */
export async function revertName(
  ctx: AgentContext,
  error: unknown,
  request: Parameters<AgentContext["walletClient"]["writeContract"]>[0],
): Promise<string | undefined> {
  const direct = nameOf(error);
  if (direct !== undefined) return direct;
  if (error instanceof Error && error.message.endsWith("_REVERTED"))
    try {
      await ctx.publicClient.simulateContract({ ...request, account: ctx.account } as never);
    } catch (replay) {
      return nameOf(replay);
    }
  return undefined;
}

/**
 * Sends a transaction. A revert whose custom error is one of `lost` means another agent got there
 * first: it is logged once as `{event:"raced"}` (unless `fields` is null) and the call returns
 * false. Any other failure propagates, so a 429 or a stale index reaches the loop's backoff.
 */
export async function attempt(
  ctx: AgentContext,
  what: string,
  request: Parameters<AgentContext["walletClient"]["writeContract"]>[0],
  lost: readonly string[],
  fields: Record<string, unknown> | null = {},
): Promise<boolean> {
  try {
    await send(ctx, what, request);
    return true;
  } catch (error) {
    const name = await revertName(ctx, error, request);
    if (name === undefined || !lost.includes(name)) throw error;
    if (fields !== null) ctx.log("raced", { action: what, error: name, ...fields });
    return false;
  }
}
