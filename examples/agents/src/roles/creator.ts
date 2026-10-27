// The creator. Each tick it turns the questions its model wants asked, and the human suggestions its
// model can write up, into markets: upload the spec bytes, make sure the template is registered,
// post the creation bond and call `createMarket`. `maxPairs` is clamped to what the contract will
// accept right now (the juror security bound and the creator's own exposure limit); with no room
// the creator logs `cap_exhausted`, sends nothing and tries again on a later tick.
//
// A suggestion is claimed through the API first. Claims are not exclusive (each creator claims once),
// so a 409 only means "this identity already claimed it", for example from a duplicated process.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeEventLog, keccak256, type Hex } from "viem";
import {
  BlinkApiError,
  GM_LT_V1,
  QUESTION_CLASS,
  ROLE,
  agentAbi,
  templateIdFor,
  type MarketSpecV02,
} from "@blink/client";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";
import type { QuestionDraft } from "../lib/model.ts";
import { send } from "../lib/session.ts";

/** The template of every class B and C market: no parser, one per class, shared by every creator. */
export const GENERIC_TEMPLATE_URI = "blink:generic-v1";
const ZERO_HASH = ("0x" + "00".repeat(32)) as Hex;
const UNIT = 1_000_000n;
/** How long after close a proposer has to propose. */
const PROPOSAL_WINDOW_SECONDS = 120;
/** Slack on top of the contract's minimum gap between the proposal and the hard deadline. */
const HARD_DEADLINE_MARGIN_SECONDS = 60;
const SUGGESTION_PAGE = 50;
/** Draft keys already created, suggestion ids claimed / finished / given up on, templates registered (`state.acted`). */
const DRAFTS = "creator.drafts";
const CLAIMED = "creator.claimed";
const DONE = "creator.suggestions";
const SKIPPED = "creator.skipped";
const TEMPLATES = "creator.templates";

type Template = { cls: number; parserHash: Hex; uri: string; templateId: Hex };
type Outcome = "created" | "exists" | "exhausted";

const actedOn = (ctx: AgentContext, action: string) => (ctx.state.data.acted[action] ??= []);
const minOf = (values: bigint[]) => values.reduce((a, b) => (b < a ? b : a));
const lower = (value: string) => value.toLowerCase();
const isRefusal = (error: unknown, status: number, code: string) =>
  error instanceof BlinkApiError && error.status === status && error.body.code === code;

const readChain = <T>(ctx: AgentContext, address: string, abi: unknown, functionName: string, args: unknown[] = []) =>
  ctx.publicClient.readContract({ address: address as Hex, abi, functionName, args } as never) as Promise<T>;

function templateFor(spec: MarketSpecV02): Template {
  if (spec.class === "A") {
    const computation = spec.computation!;
    if (
      lower(computation.templateId) !== lower(GM_LT_V1.templateId) ||
      lower(computation.parserHash) !== lower(GM_LT_V1.parserHash)
    )
      throw new Error("SPEC_TEMPLATE_UNSUPPORTED");
    return GM_LT_V1;
  }
  const cls = spec.class === "B" ? QUESTION_CLASS.B_VERIFIABLE : QUESTION_CLASS.C_JUDGMENT;
  return { cls, parserHash: ZERO_HASH, uri: GENERIC_TEMPLATE_URI, templateId: templateIdFor(cls, ZERO_HASH, GENERIC_TEMPLATE_URI) };
}

/** The parser's exact bytes, which the template's `parserHash` names, into the content store. */
async function uploadParser(ctx: AgentContext) {
  const bytes = await readFile(fileURLToPath(import.meta.resolve("@blink/client/templates/gm-lt-v1")));
  if (keccak256(bytes) !== GM_LT_V1.parserHash) throw new Error("PARSER_HASH_MISMATCH");
  await ctx.client.uploadContent(new Uint8Array(bytes), "text/plain");
}

/** Registers the template unless this agent did, or the API lists it (`registerTemplate` is idempotent anyway). */
async function ensureTemplate(ctx: AgentContext, template: Template) {
  const known = actedOn(ctx, TEMPLATES);
  if (known.includes(template.templateId)) return;
  // ponytail: the first 100 templates only; page through if a deployment ever has more.
  const listed = (await ctx.client.listTemplates({ limit: 100 })).items.some(
    (t) => lower(t.templateId) === lower(template.templateId),
  );
  if (!listed) {
    if (template === GM_LT_V1) await uploadParser(ctx);
    await send(ctx, "REGISTER_TEMPLATE", {
      address: ctx.deployment.generation.markets as Hex,
      abi: agentAbi.markets,
      functionName: "registerTemplate",
      args: [template.cls, template.parserHash, template.uri],
    });
    ctx.log("template_registered", { templateId: template.templateId });
  }
  known.push(template.templateId);
  await ctx.state.save();
}

/**
 * How many pairs `createMarket` accepts from this creator now, at most `wanted`: the market cap, the
 * security bound (open payout stays within the jurors' attack cost over the security multiple) and the
 * creator's exposure limit. These are the checks of the contract, read from the chain.
 */
async function pairsAvailable(ctx: AgentContext, wanted: number): Promise<bigint> {
  const { params, generation } = ctx.deployment;
  const markets = generation.markets;
  const me = ctx.account.address;
  const [attackCost, openTotal, openByMe, stake, multiplier] = await Promise.all([
    readChain<bigint>(ctx, generation.jurors, agentAbi.jurors, "attackCostMicros"),
    readChain<bigint>(ctx, markets, agentAbi.markets, "openPayoutTotal"),
    readChain<bigint>(ctx, markets, agentAbi.markets, "openPayoutByCreator", [me]),
    readChain<bigint>(ctx, generation.registry, agentAbi.registry, "roleStake", [me, ROLE.CREATOR]),
    readChain<bigint>(ctx, generation.registry, agentAbi.registry, "limitMultiplierBps", [me, ROLE.CREATOR]),
  ]);
  const securityRoom = (attackCost * 10_000n) / BigInt(params.securityMultipleBps) - openTotal;
  const exposureRoom = (stake * multiplier * BigInt(params.creatorExposureMultiple)) / 10_000n - openByMe;
  const pairs = minOf([BigInt(wanted), BigInt(params.maxMarketPairs), securityRoom / UNIT, exposureRoom / UNIT]);
  return pairs > 0n ? pairs : 0n;
}

/** Creates the market for `spec` unless this creator already has one with these exact bytes. */
async function createFor(ctx: AgentContext, draft: QuestionDraft, spec: MarketSpecV02): Promise<Outcome> {
  const { params, generation } = ctx.deployment;
  const markets = generation.markets as Hex;
  const bytes = new TextEncoder().encode(JSON.stringify(spec));
  const specHash = keccak256(bytes);
  // A creation that landed but was never recorded (a crash, a lost answer) must not be paid for twice.
  const earlier = await ctx.publicClient.getContractEvents({
    address: markets,
    abi: agentAbi.markets,
    eventName: "MarketCreated",
    args: { creator: ctx.account.address, specHash },
    fromBlock: BigInt(ctx.deployment.startBlock),
  } as never);
  if (earlier.length > 0) {
    ctx.log("market_exists", { key: draft.key, specHash });
    return "exists";
  }
  const pairs = await pairsAvailable(ctx, draft.maxPairs);
  if (pairs < 1n) {
    ctx.log("cap_exhausted", { key: draft.key, wantedPairs: draft.maxPairs });
    return "exhausted";
  }
  const template = templateFor(spec);
  await ensureTemplate(ctx, template);
  await ctx.client.uploadContent(bytes, "application/json");

  // The windows of the contract, counted from chain time. The extra first-use window is always added:
  // it only makes the market open for a little longer once the template is reviewed.
  const now = (await ctx.publicClient.getBlock({ blockTag: "latest" })).timestamp;
  const closeAt =
    now + BigInt(params.creationWindow[template.cls]! + params.firstUseExtraWindow + draft.closeInSeconds);
  const proposalDeadline = closeAt + BigInt(PROPOSAL_WINDOW_SECONDS);
  const hardDeadline =
    proposalDeadline +
    BigInt(
      params.resultChallengeWindow[template.cls]! +
        params.maxRounds * (params.commitSeconds + params.revealSeconds + params.appealSeconds) +
        HARD_DEADLINE_MARGIN_SECONDS,
    );
  const bond = await readChain<bigint>(ctx, generation.registry, agentAbi.registry, "bondFor", [
    ctx.account.address,
    ROLE.CREATOR,
    (pairs * UNIT * BigInt(params.creationBondBps)) / 10_000n,
  ]);
  await send(ctx, "APPROVE_BOND", {
    address: ctx.deployment.shared.busd as Hex,
    abi: agentAbi.usd,
    functionName: "approve",
    args: [markets, bond],
  });
  const receipt = await send(ctx, "CREATE_MARKET", {
    address: markets,
    abi: agentAbi.markets,
    functionName: "createMarket",
    args: [
      {
        templateId: template.templateId,
        specHash,
        specURI: `/v1/content/${specHash}`,
        replay: false,
        closeAt,
        proposalDeadline,
        hardDeadline,
        maxPairs: pairs,
      },
    ],
  });
  let marketId = "";
  for (const entry of receipt.logs) {
    try {
      const event = decodeEventLog({ abi: agentAbi.markets, ...entry });
      if (event.eventName === "MarketCreated") marketId = event.args.marketId.toString();
    } catch {
      // Not an event of the markets ABI.
    }
  }
  ctx.log("market_created", {
    key: draft.key,
    marketId,
    specHash,
    maxPairs: pairs.toString(),
    ...(spec.suggestionId === undefined ? {} : { suggestionId: spec.suggestionId }),
  });
  return "created";
}

async function createDrafts(ctx: AgentContext) {
  const created = actedOn(ctx, DRAFTS);
  for (const draft of await ctx.model.questions()) {
    if (created.includes(draft.key)) continue;
    if ((await createFor(ctx, draft, draft.spec)) === "exhausted") continue;
    created.push(draft.key);
    await ctx.state.save();
  }
}

/**
 * Claims the open suggestions the model can write up. The claim is saved before anything else is
 * done for it. A 409 means this identity has claimed it already (the claim of another creator does
 * not refuse); it is logged once and the suggestion is left alone.
 */
async function claimSuggestions(ctx: AgentContext) {
  const claimed = actedOn(ctx, CLAIMED);
  const skipped = actedOn(ctx, SKIPPED);
  // ponytail: the newest page of the queue only; older open suggestions wait until this one drains.
  const page = await ctx.client.listSuggestions({ status: "OPEN", limit: SUGGESTION_PAGE });
  for (const item of page.items) {
    if (claimed.includes(item.id) || skipped.includes(item.id)) continue;
    if ((await ctx.model.fromSuggestion(item.text)) === null) continue;
    try {
      await ctx.client.claimSuggestion(item.id);
    } catch (error) {
      if (!isRefusal(error, 409, "ALREADY_CLAIMED")) throw error;
      skipped.push(item.id);
      await ctx.state.save();
      ctx.log("suggestion_already_claimed", { suggestionId: item.id });
      continue;
    }
    claimed.push(item.id);
    await ctx.state.save();
    ctx.log("suggestion_claimed", { suggestionId: item.id });
  }
}

/** Writes up every claimed suggestion that has no market yet; a claim from an earlier run is resumed here. */
async function createClaimed(ctx: AgentContext) {
  const done = actedOn(ctx, DONE);
  for (const id of actedOn(ctx, CLAIMED).filter((claimed) => !done.includes(claimed))) {
    const draft = await ctx.model.fromSuggestion((await ctx.client.getSuggestion(id)).text);
    if (draft === null) continue;
    if ((await createFor(ctx, draft, { ...draft.spec, suggestionId: id })) === "exhausted") continue;
    done.push(id);
    await ctx.state.save();
  }
}

export const creator: RoleTick = async (ctx) => {
  await createDrafts(ctx);
  await claimSuggestions(ctx);
  await createClaimed(ctx);
};
