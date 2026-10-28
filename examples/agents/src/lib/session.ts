import { BlinkApiError, ROLE, agentAbi, createBlinkClient } from "@blink/client";
import type { Hex } from "viem";
import type { AgentContext, RoleName } from "./env.ts";

/** The registry role each role name joins. A keeper holds no role: finalizing is permissionless. */
export const ROLE_ID: Record<RoleName, number | null> = {
  creator: ROLE.CREATOR,
  maker: ROLE.MAKER,
  trader: ROLE.TAKER,
  forecaster: ROLE.FORECASTER,
  proposer: ROLE.PROPOSER,
  challenger: ROLE.CHALLENGER,
  juror: ROLE.JUROR,
  keeper: null,
};

const KEY_ATTEMPTS = 7;
const KEY_PAUSE_MS = 1000;
const KEY_PAUSE_MAX_MS = 30_000;
const RECEIPT_TIMEOUT_MS = 180_000;
// An estimate in one second may mine in the next, appending a token supply checkpoint during claim.
const GAS_HEADROOM_PERCENT = 25n;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A transaction of this agent's wallet, waited for. Only a receipt that says `reverted` is a revert
 * (`<WHAT>_REVERTED`, a final refusal by the chain); any other status that is not `success` is an
 * answer this code does not understand (`<WHAT>_RECEIPT_UNKNOWN`), which a caller may retry.
 */
export async function send(
  ctx: AgentContext,
  what: string,
  request: Parameters<AgentContext["walletClient"]["writeContract"]>[0],
) {
  const estimate = await ctx.publicClient.estimateContractGas({ ...request, account: ctx.account } as never);
  const gas = (estimate * (100n + GAS_HEADROOM_PERCENT) + 99n) / 100n;
  const hash = await ctx.walletClient.writeContract({ ...request, gas });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({
    hash,
    timeout: RECEIPT_TIMEOUT_MS,
  });
  if (receipt.status === "reverted") throw new Error(`${what}_REVERTED`);
  if (receipt.status !== "success") throw new Error(`${what}_RECEIPT_UNKNOWN`);
  return receipt;
}

const read = (ctx: AgentContext, request: Record<string, unknown>) =>
  ctx.publicClient.readContract(request as never) as Promise<never>;

/**
 * Brings the agent to a working state, and can be run again at any time: each step first looks at
 * the chain and does only what is missing. Claim test bUSD, register, join every role except the
 * trader (which joins TAKER when it first trades), stake a juror's platform tokens, and get an API
 * key by proving the wallet. A key from an earlier run is revoked once the new one works.
 */
export async function onboard(ctx: AgentContext): Promise<void> {
  const { shared, generation, params } = ctx.deployment;
  const owner = ctx.account.address;
  const registry = generation.registry as Hex;
  const busd = shared.busd as Hex;
  const stake = BigInt(params.minRoleStake);
  const fee = BigInt(params.registrationFee);

  const busdBalance = () =>
    read(ctx, { address: busd, abi: agentAbi.usd, functionName: "balanceOf", args: [owner] }) as Promise<bigint>;
  if ((await busdBalance()) < stake + fee) {
    await send(ctx, "FAUCET_CLAIM", {
      address: shared.faucet as Hex,
      abi: agentAbi.faucet,
      functionName: "claim",
    });
    ctx.log("faucet_claimed");
  }

  const registered = await read(ctx, {
    address: registry,
    abi: agentAbi.registry,
    functionName: "isRegistered",
    args: [owner],
  });
  if (!registered) {
    await send(ctx, "APPROVE_FEE", {
      address: busd,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [registry, fee],
    });
    await send(ctx, "REGISTER", { address: registry, abi: agentAbi.registry, functionName: "register" });
    ctx.log("registered");
  }

  for (const name of ctx.roles) {
    const role = ROLE_ID[name];
    if (role === null || name === "trader") continue;
    const held = await read(ctx, {
      address: registry,
      abi: agentAbi.registry,
      functionName: "hasRole",
      args: [owner, role],
    });
    if (held) continue;
    await send(ctx, "APPROVE_STAKE", {
      address: busd,
      abi: agentAbi.usd,
      functionName: "approve",
      args: [registry, stake],
    });
    await send(ctx, "JOIN_ROLE", {
      address: registry,
      abi: agentAbi.registry,
      functionName: "joinRole",
      args: [role, stake],
    });
    ctx.log("joined_role", { role: name });
  }

  if (ctx.roles.includes("juror")) await stakeAllTokens(ctx);

  await issueApiKey(ctx);
}

/** A juror stakes the whole platform-token balance; once it has, the balance is zero and this does nothing. */
async function stakeAllTokens(ctx: AgentContext) {
  const token = ctx.deployment.shared.token as Hex;
  const jurors = ctx.deployment.generation.jurors as Hex;
  const balance = (await read(ctx, {
    address: token,
    abi: agentAbi.platformToken,
    functionName: "balanceOf",
    args: [ctx.account.address],
  })) as bigint;
  if (balance === 0n) return;
  await send(ctx, "APPROVE_TOKEN", {
    address: token,
    abi: agentAbi.platformToken,
    functionName: "approve",
    args: [jurors, balance],
  });
  await send(ctx, "STAKE", {
    address: jurors,
    abi: agentAbi.jurors,
    functionName: "stake",
    args: [balance],
  });
  ctx.log("juror_staked", { amount: balance.toString() });
}

/** One wallet-proof round trip: a challenge, the signature over it, and the answer of the API. */
async function walletProof(
  ctx: AgentContext,
  anonymous: AgentContext["client"],
  request: { action: "issue" } | { action: "revoke"; keyId: string },
) {
  const address = ctx.account.address.toLowerCase();
  const challenge = await anonymous.createWalletChallenge({ address, ...request });
  return anonymous.verifyWallet({
    challengeId: challenge.challengeId,
    signature: await ctx.account.signMessage({ message: challenge.message }),
  });
}

/**
 * The API issues a key only once its index has seen the registration, so a refusal for that reason
 * is retried with a fresh challenge and a growing pause. Then the previous key, whose id is in the
 * saved state, is revoked: an account may hold only a few keys, and a restart must not use them up.
 */
async function issueApiKey(ctx: AgentContext) {
  const anonymous = createBlinkClient(ctx.apiUrl);
  let issued: Awaited<ReturnType<typeof walletProof>>;
  for (let attempt = 0, pause = KEY_PAUSE_MS; ; attempt++, pause *= 2) {
    try {
      issued = await walletProof(ctx, anonymous, { action: "issue" });
      break;
    } catch (error) {
      const retryable =
        error instanceof BlinkApiError && ["NOT_REGISTERED", "INDEX_STALE"].includes(error.body.code);
      if (!retryable || attempt + 1 >= KEY_ATTEMPTS) throw error;
      await sleep(Math.min(pause, KEY_PAUSE_MAX_MS));
    }
  }
  if (!("apiKey" in issued)) throw new Error("NO_API_KEY_ISSUED");
  ctx.log.redact(issued.apiKey);
  const previous = ctx.state.data.apiKeyId;
  // The client is replaced, not changed: it holds the key it was made with.
  ctx.client = createBlinkClient(ctx.apiUrl, issued.apiKey);
  ctx.state.data.apiKeyId = issued.keyId;
  await ctx.state.save();
  ctx.log("api_key_issued", { keyId: issued.keyId });
  if (previous && previous !== issued.keyId)
    try {
      await walletProof(ctx, anonymous, { action: "revoke", keyId: previous });
      ctx.log("api_key_revoked", { keyId: previous });
    } catch (error) {
      // An old key that stays valid until it expires does no harm; do not stop the agent for it.
      ctx.log("api_key_revoke_failed", {
        keyId: previous,
        code: error instanceof BlinkApiError ? error.body.code : "UNKNOWN",
      });
    }
}
