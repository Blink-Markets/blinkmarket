import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseEventLogs,
  toBytes,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
} from "viem";
import { verifyProof, merkleRoot } from "../../packages/domain/src/forecast-merkle.ts";
import {
  BlinkApiError,
  NO_CONTENT_HASH,
  createBlinkClient,
  forecastDigest,
  forecastLeaf,
  forecastTypedData,
  verifySignedQuote,
} from "../../packages/client/src/index.ts";
import { assertNoRoleKeys } from "../../packages/runtime/src/index.ts";
import { quoteTypes, type QuoteFields } from "../../packages/schemas/src/index.ts";
import { rebuildChainProjection } from "../../packages/application/src/chain-indexer.ts";
import { postgresProtocolIndexStore } from "../../packages/adapters/src/protocol-index-store.ts";
import {
  ALPHA_FORECAST_SCHEDULE,
  ROLE,
  protocolAbi,
  startLocalAlpha,
  waitFor,
  type LocalAlpha,
  type PlatformName,
} from "../../scripts/local-alpha.ts";
import { contractWalletArtifacts } from "../helpers/contract-wallet.ts";

/**
 * P2 spec 2.1.3 / Task 11: the infrastructure alone (the real API, indexer and worker as separate
 * processes with explicit key-free environments, a real PostgreSQL and Anvil) serves a full normal
 * market lifecycle for independent actors that reach it only through the public API, `@blink/client`
 * and the contracts. `pnpm alpha:local` runs this file.
 *
 * Time: real time. The alpha protocol periods are 60 s (creation window, challenge window), so the
 * scenario waits for chain time with `waitForChainTime` (a condition on the chain head, which a
 * heartbeat keeps moving) and for the platform with polling. The database clock and the chain clock
 * both follow the wall clock; no clock offset or chain timestamp is shifted, because the API and the
 * worker refuse a shifted business clock. About six minutes in total.
 */
const adminUrl = process.env.TEST_POSTGRES_ADMIN_URL;
const skip = adminUrl
  ? false
  : "TEST_POSTGRES_ADMIN_URL is not set: the local alpha needs a dedicated PostgreSQL with CREATEDB and CREATEROLE";
if (skip) console.error("local-alpha test skipped: " + skip);

const MAKER_DEPOSIT = 100_000_000n;
/**
 * The deadline budget, in seconds. Every deadline-bound step is guarded by `requireRemaining` right
 * before it runs, and the market's lifetime after opening is the explicit sum of these budgets, so a
 * runner too slow for the scenario fails with the step name instead of racing a deadline.
 */
const FORECAST_LEAD = BigInt(ALPHA_FORECAST_SCHEDULE.preCloseLeadSeconds);
/** The worker plans windows per 30 s bucket and the index follows the chain: a window shows up within this. */
const WINDOW_PLAN_SECONDS = 45n;
const FORECAST_SUBMIT_SECONDS = 10n; // one signed forecast, request included
const ROOT_CHECK_SECONDS = 5n; // the sealed-root read must happen before the window closes
const FORECAST_BUDGET_SECONDS = 2n * FORECAST_SUBMIT_SECONDS + ROOT_CHECK_SECONDS;
const RFQ_FLOW_SECONDS = 35n; // create an RFQ, two quotes, verify, approve and fill
const RFQ_APPROVE_SECONDS = 15n; // approval and fill must still fit in the quote's life and the market's
const RFQ_FILL_SECONDS = 8n; // the fill transaction alone
const QUOTE_TTL_SECONDS = 50n;
const FLOW_SLACK_SECONDS = 20n; // fill tracking and read-model waits between the two RFQs
const PROPOSE_SECONDS = 30n;
const MIN_OPEN_SECONDS = WINDOW_PLAN_SECONDS + FORECAST_BUDGET_SECONDS + 2n * RFQ_FLOW_SECONDS;
/** Market lifetime after it opens. */
const OPEN_FOR_SECONDS = MIN_OPEN_SECONDS + FLOW_SLACK_SECONDS;
// The forecasts must fit between the market's opening and the window's deadline.
assert.ok(OPEN_FOR_SECONDS - FORECAST_LEAD >= WINDOW_PLAN_SECONDS + FORECAST_BUDGET_SECONDS);
assert.ok(QUOTE_TTL_SECONDS > RFQ_FLOW_SECONDS);

/** Fails with the step, the seconds left and the budget when `deadline` is too close on the chain clock. */
async function requireRemaining(alpha: LocalAlpha, step: string, deadline: bigint, budget: bigint) {
  const remaining = deadline - (await alpha.chainNow());
  assert.ok(
    remaining >= budget,
    `${step}: ${remaining} s left before its deadline, the step needs ${budget} s (the runner is too slow for this scenario)`,
  );
}
const POLL_MS = 1500; // the public read limit refills one request per second
const wait = <T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 120_000) =>
  waitFor(what, read, timeoutMs, POLL_MS);

const quoteStruct = (q: QuoteFields) => ({
  marketId: BigInt(q.marketId),
  specHash: q.specHash as Hex,
  maker: q.maker as Hex,
  taker: q.taker as Hex,
  side: Number(q.side),
  quantity: BigInt(q.quantity),
  priceBps: Number(q.priceBps),
  validAfter: BigInt(q.validAfter),
  expiresAt: BigInt(q.expiresAt),
  nonce: BigInt(q.nonce),
  epoch: BigInt(q.epoch),
});

async function deployWallet(alpha: LocalAlpha, owner: LocalAccount) {
  const { wallet } = contractWalletArtifacts();
  const receipt = await alpha.anvil.publicClient.waitForTransactionReceipt({
    hash: await alpha.anvil
      .wallet(owner)
      .deployContract({ abi: wallet.abi, bytecode: wallet.bytecode, args: [owner.address] }),
  });
  assert.equal(receipt.status, "success");
  return receipt.contractAddress as Address;
}

test(
  "infrastructure alone serves a normal market lifecycle for independent actors",
  { skip, timeout: 900_000 },
  async () => {
    const started = Date.now();
    const alpha = await startLocalAlpha({ adminUrl: adminUrl! });
    let failure: unknown;
    try {
      await scenario(alpha);
      console.log("local alpha: lifecycle finished in " + Math.round((Date.now() - started) / 1000) + " s");
    } catch (error) {
      // Codes only: the processes print no secrets.
      console.error(alpha.failureLogs());
      failure = error;
    }
    // Every cleanup step runs; a cleanup failure never hides the scenario's own failure.
    try {
      await alpha.stop();
    } catch (cleanupError) {
      if (failure === undefined) throw cleanupError;
      console.error(String(cleanupError));
    }
    if (failure !== undefined) throw failure;
  },
);

async function scenario(alpha: LocalAlpha) {
  const { anvil, deployment: d, markets, accounts, write, read } = alpha;
  const mread = <T = any>(fn: string, args: readonly unknown[] = []) =>
    read<T>(markets, protocolAbi.markets, fn, args);
  const anonymous = createBlinkClient(alpha.apiUrl);
  const as = (apiKey: string) => createBlinkClient(alpha.apiUrl, apiKey);
  const events = (receipt: { logs: readonly any[] }, abi: Abi, eventName: string) =>
    parseEventLogs({ abi, logs: receipt.logs as never, eventName } as never) as unknown as {
      args: Record<string, any>;
    }[];

  // The actors: distinct Anvil accounts, none of them the deployer or the treasury.
  const creator = accounts.admin;
  const makerEoa = accounts.maker;
  const proposer = accounts.proposer;
  const walletOwner = accounts.challenger;
  const juror = accounts.arbiter;
  const keeper = accounts.minter; // opens, finalizes, distributes and anchors: all permissionless
  const taker = accounts.taker;
  const forecasterA = accounts.taker2;
  const forecasterB = taker; // the taker also forecasts, with a second role

  // --- Identity and roles (faucet claim, registration, role stakes) -------------------------------
  assert.equal((await anonymous.getConfig()).chainId, 84532);
  assert.deepEqual((await anonymous.getDeployment()).deployment.generation, d.generation);
  await alpha.onboard(creator, ROLE.CREATOR);
  // Market creation is bounded by what the jurors have at stake.
  await alpha.onboard(juror, null);
  const stake = 1000n * 10n ** 18n;
  await write(juror, d.shared.token, erc20Abi as Abi, "approve", [d.generation.jurors, stake]);
  await write(juror, d.generation.jurors, protocolAbi.jurors, "stake", [stake]);

  // --- A human suggestion, claimed by the creator and linked by suggestionId ----------------------
  const { id: suggestionId } = await anonymous.submitSuggestion({
    text: "Will the local alpha market resolve YES within the hour?",
    sourceUrls: ["https://example.com/local-alpha"],
  });
  assert.equal((await anonymous.getSuggestion(suggestionId)).status, "OPEN");
  const creatorApi = as(await alpha.apiKeyFor(creator));
  assert.equal((await creatorApi.claimSuggestion(suggestionId)).status, "CLAIMED");

  // --- The other actors join before the market exists: their delays then cannot eat the market's deadlines --------------------------------------------
  await alpha.onboard(taker, ROLE.TAKER);
  await write(taker, d.generation.registry, protocolAbi.registry, "joinRole", [ROLE.FORECASTER, BigInt(d.params.minRoleStake)]);
  await alpha.onboard(makerEoa, ROLE.MAKER);
  await write(makerEoa, markets, protocolAbi.markets, "depositMaker", [MAKER_DEPOSIT]);
  await alpha.onboard(forecasterA, ROLE.FORECASTER);
  await alpha.onboard(proposer, ROLE.PROPOSER);
  // The second maker is a contract wallet (ERC-1271), owned by walletOwner and acting through execute.
  const walletMaker = await deployWallet(alpha, walletOwner);
  const walletAbi = contractWalletArtifacts().wallet.abi;
  for (const [address, abi, fn, args] of [
    ...alpha.onboardingCalls(ROLE.MAKER),
    [markets, protocolAbi.markets, "depositMaker", [MAKER_DEPOSIT]] as [string, Abi, string, readonly unknown[]],
  ])
    await write(walletOwner, walletMaker, walletAbi, "execute", [
      address,
      0n,
      encodeFunctionData({ abi, functionName: fn, args } as never),
    ]);
  const key = {
    taker: await alpha.apiKeyFor(taker),
    maker: await alpha.apiKeyFor(makerEoa),
    wallet: await alpha.apiKeyFor(walletOwner, walletMaker),
    forecasterA: await alpha.apiKeyFor(forecasterA),
  };
  // The account is read from the index, which may not yet hold the block that granted the role.
  const account = await wait("wallet maker role indexed", async () => {
    const found = await anonymous.getAccount({ address: walletMaker });
    return found.roles.MAKER?.hasRole ? found : null;
  });
  assert.equal(account.registered, true);

  // --- Template, content upload and market creation -----------------------------------------------
  const templateReceipt = await write(creator, markets, protocolAbi.markets, "registerTemplate", [
    1, // B_VERIFIABLE
    keccak256(toBytes("local-alpha-parser")),
    "ipfs://local-alpha-template",
  ]);
  const templateId = events(templateReceipt, protocolAbi.markets, "TemplateRegistered")[0]!.args.templateId as Hex;
  const specBytes = new TextEncoder().encode(
    JSON.stringify({
      schema: "blink.market-spec/0.2",
      title: "Local alpha market",
      question: "Does the local alpha scenario finish with YES?",
      class: "B",
      resolution: { yes: "The proposer says YES.", no: "The proposer says NO." },
      sources: ["https://example.com/local-alpha"],
      suggestionId,
    }),
  );
  const specHash = keccak256(specBytes);
  const uploaded = await creatorApi.uploadContent(specBytes, "application/json");
  assert.equal(uploaded.hash, specHash);
  const createdAt = (await anvil.publicClient.getBlock()).timestamp;
  // openAt = creation + the class window (60 s) + the first-use extra window (30 s). Every actor is
  // onboarded already, so the market's whole lifetime is spent on the steps that need it.
  const closeAt = createdAt + 90n + OPEN_FOR_SECONDS;
  const proposalDeadline = closeAt + 120n;
  const created = await write(creator, markets, protocolAbi.markets, "createMarket", [
    {
      templateId,
      specHash,
      specURI: alpha.apiUrl + "/v1/content/" + specHash,
      replay: false,
      closeAt,
      proposalDeadline,
      hardDeadline: proposalDeadline + 400n,
      maxPairs: 100n,
    },
  ]);
  const marketId = events(created, protocolAbi.markets, "MarketCreated")[0]!.args.marketId as bigint;
  const ref = { marketId: String(marketId) };
  const onChain = await mread("getMarket", [marketId]);
  const openAt = BigInt(onChain.openAt);
  assert.equal(BigInt(onChain.closeAt), closeAt);
  // The creation transaction lands a little after the block read above; the slack covers that delay.
  assert.ok(
    closeAt - openAt >= MIN_OPEN_SECONDS,
    `the market is open for ${closeAt - openAt} s, the scenario needs ${MIN_OPEN_SECONDS} s`,
  );

  // The suggestion shows MARKET_CREATED as soon as the index has the linked market.
  const linked = await wait("suggestion MARKET_CREATED", async () => {
    const found = await anonymous.getSuggestion(suggestionId);
    return found.status === "MARKET_CREATED" ? found : null;
  });
  assert.deepEqual(linked.specHashes, [specHash]);
  assert.equal((await anonymous.getMarket(ref)).market.state, "PENDING");
  assert.deepEqual(await anonymous.getMarketSpec(ref, specHash).then((s) => s.suggestionId), suggestionId);

  // --- Open ----------------------------------------------------------------------------------------
  await alpha.waitForChainTime(openAt);
  await write(keeper, markets, protocolAbi.markets, "open", [marketId]);
  await wait("market OPEN", async () => (await anonymous.getMarket(ref)).market.state === "OPEN");

  // --- Signed forecasts in the PRE_CLOSE window --------------------------------------------------
  const window = await wait("PRE_CLOSE window open", async () => {
    const page = await anonymous.listForecastWindows(ref);
    return page.items.find((w) => w.horizonType === "PRE_CLOSE" && w.status === "OPEN") ?? null;
  }, 60_000);
  assert.equal(BigInt(window.deadline), closeAt - FORECAST_LEAD);
  const windowDeadline = BigInt(window.deadline);
  await requireRemaining(alpha, "forecast window found", windowDeadline, FORECAST_BUDGET_SECONDS);
  const answers: { digest: Hex; leaf: Hex }[] = [];
  for (const [signer, apiKey, probabilityBps] of [
    [forecasterA, key.forecasterA, 7200],
    [forecasterB, key.taker, 6400],
  ] as const) {
    await requireRemaining(
      alpha,
      `forecast submission by ${signer.address}`,
      windowDeadline,
      FORECAST_SUBMIT_SECONDS + ROOT_CHECK_SECONDS,
    );
    const message = {
      forecaster: signer.address.toLowerCase(),
      markets,
      marketId: ref.marketId,
      horizon: window.horizon,
      scheduledAt: window.scheduledAt,
      probabilityBps,
      contentHash: NO_CONTENT_HASH,
    };
    const signature = await signer.signTypedData(forecastTypedData({ anchor: d.shared.anchor, message }));
    const receipt = await as(apiKey).submitForecast(ref, {
      horizon: window.horizon,
      scheduledAt: window.scheduledAt,
      probabilityBps,
      contentHash: NO_CONTENT_HASH,
      signature,
    });
    const digest = forecastDigest({ anchor: d.shared.anchor, message });
    assert.deepEqual(receipt, { digest, leaf: forecastLeaf(digest) });
    answers.push(receipt as { digest: Hex; leaf: Hex });
  }
  // Sealed until the deadline: an outsider sees no root and no leaves.
  await requireRemaining(alpha, "sealed-root check", windowDeadline, ROOT_CHECK_SECONDS);
  assert.equal((await anonymous.getForecastWindow({ windowId: window.windowId })).root, null);

  // --- RFQ with two makers: one EOA and one contract wallet, the taker fills the best --------------
  let nonce = BigInt(Date.now()) * 1000n;
  const quoteFrom = async (maker: Address, quantity: string, priceBps: string): Promise<QuoteFields> => {
    const now = await alpha.chainNow();
    return {
      marketId: ref.marketId,
      specHash,
      maker: maker.toLowerCase(),
      taker: taker.address.toLowerCase(),
      side: "0",
      quantity,
      priceBps,
      validAfter: String(now),
      expiresAt: String(now + QUOTE_TTL_SECONDS),
      nonce: String(nonce++),
      epoch: String(await mread("makerEpoch", [maker])),
    };
  };
  const sign = (signer: LocalAccount, quote: QuoteFields) =>
    signer.signTypedData({
      domain: { name: "Blink RFQ", version: "0.2", chainId: 84532, verifyingContract: markets },
      types: quoteTypes,
      primaryType: "Quote",
      message: quoteStruct(quote),
    });
  const takerApi = as(key.taker);
  const trusted = (await takerApi.getDeployment()).deployment;
  /** The taker's side of a fill: check the quote itself, approve what it can cost, fill on chain. */
  const fill = async (label: string, quantity: string, best: { quote: QuoteFields; signature: string }) => {
    const expiresAt = BigInt(best.quote.expiresAt);
    const verified = await verifySignedQuote(best.quote, best.signature as Hex, {
      publicClient: anvil.publicClient,
      deployment: trusted,
      market: (await takerApi.getMarket(ref)).market,
      rfq: { marketId: ref.marketId, side: "YES", quantity, taker: taker.address },
      now: await alpha.chainNow(),
      feeBps: trusted.params.feeBps,
    });
    await requireRemaining(alpha, `${label} approval: quote expiry`, expiresAt, RFQ_APPROVE_SECONDS);
    await requireRemaining(alpha, `${label} approval: market close`, closeAt, RFQ_APPROVE_SECONDS);
    await write(taker, d.shared.busd, erc20Abi as Abi, "approve", [markets, verified.maxCost]);
    await requireRemaining(alpha, `${label} fill: quote expiry`, expiresAt, RFQ_FILL_SECONDS);
    await requireRemaining(alpha, `${label} fill: market close`, closeAt, RFQ_FILL_SECONDS);
    const receipt = await write(taker, markets, protocolAbi.markets, "fillQuote", [
      quoteStruct(best.quote),
      best.signature,
    ]);
    const filled = events(receipt, protocolAbi.markets, "QuoteFilled")[0]!.args;
    assert.equal(filled.digest, verified.digest);
    return { receipt, verified };
  };

  await requireRemaining(alpha, "first RFQ creation", closeAt, RFQ_FLOW_SECONDS);
  const rfq = await takerApi.createRfq({ marketId: ref.marketId, side: "YES", quantity: "10" });
  const eoaQuote = await quoteFrom(makerEoa.address, "10", "4500");
  const walletQuote = await quoteFrom(walletMaker, "10", "4000");
  const eoaPosted = await as(key.maker).postQuote(rfq.rfqId, { quote: eoaQuote, signature: await sign(makerEoa, eoaQuote) });
  const walletPosted = await as(key.wallet).postQuote(rfq.rfqId, {
    quote: walletQuote,
    signature: await sign(walletOwner, walletQuote),
  });
  assert.deepEqual((await as(key.maker).listRfqs()).items.map((r) => r.rfqId), [rfq.rfqId]);
  const quotes = (await takerApi.listQuotes(rfq.rfqId)).items;
  assert.deepEqual(quotes.map((q) => q.quote.priceBps), ["4000", "4500"]);
  const first = await fill("first fill", "10", quotes[0]!);
  assert.equal(first.verified.digest, walletPosted.digest);
  assert.notEqual(first.verified.digest, eoaPosted.digest);
  // The platform follows the fill through the transaction hash the taker registered.
  const tracked = await takerApi.trackTransaction({ txHash: first.receipt.transactionHash });
  const tracking = await wait("fill transaction tracked", async () => {
    const found = await takerApi.getTransaction({ deploymentId: d.deploymentId, txHash: first.receipt.transactionHash });
    return ["INCLUDED", "FINALIZED"].includes(found.status) ? found : null;
  });
  assert.ok(tracked.trackingId);
  assert.equal(tracking.rejectReason, null);
  // A second RFQ filled from the EOA maker, so both signature paths settle on chain.
  await requireRemaining(alpha, "second RFQ creation", closeAt, RFQ_FLOW_SECONDS);
  const rfq2 = await takerApi.createRfq({ marketId: ref.marketId, side: "YES", quantity: "5" });
  const eoaQuote2 = await quoteFrom(makerEoa.address, "5", "5000");
  await as(key.maker).postQuote(rfq2.rfqId, { quote: eoaQuote2, signature: await sign(makerEoa, eoaQuote2) });
  await fill("second fill", "5", (await takerApi.listQuotes(rfq2.rfqId)).items[0]!);
  await wait("maker stats show both fills", async () => {
    const wallet = await anonymous.getMakerStats(walletMaker);
    const eoa = await anonymous.getMakerStats(makerEoa.address);
    return wallet.quotesFilled === 1 && eoa.quotesFilled === 1 ? { wallet, eoa } : null;
  });
  const position = await wait("taker position", async () => {
    const page = await anonymous.getPositions({ address: taker.address });
    const found = page.items.find((p) => p.marketId === ref.marketId);
    return found?.yesShares === "15" ? found : null;
  });
  assert.equal(position.marketState, "OPEN");

  // --- The worker stores the window root; a participant anchors it from its own wallet ------------
  const closed = await wait(
    "window root",
    async () => {
      const found = await anonymous.getForecastWindow({ windowId: window.windowId });
      return found.root ? found : null;
    },
    180_000,
  );
  assert.equal(closed.anchor, null);
  assert.deepEqual([...closed.leaves].sort(), answers.map((a) => a.leaf).sort());
  assert.equal(merkleRoot(closed.leaves as Hex[]), closed.root);
  for (const answer of answers) {
    const { proof } = await anonymous.getForecastProof({ windowId: window.windowId }, answer.leaf);
    assert.equal(verifyProof(proof as Hex[], closed.root as Hex, answer.leaf), true);
  }
  await write(keeper, d.shared.anchor, protocolAbi.anchor, "anchor", [closed.root]);
  const anchored = await wait("anchor visible", async () => {
    const found = await anonymous.getForecastWindow({ windowId: window.windowId });
    return found.anchor;
  });
  assert.equal(anchored.root, closed.root);
  assert.equal(anchored.by.toLowerCase(), keeper.address.toLowerCase());

  // --- Propose, finalize unchallenged, distribute fees, redeem -------------------------------------
  await alpha.waitForChainTime(closeAt);
  await requireRemaining(alpha, "proposal", proposalDeadline, PROPOSE_SECONDS);
  const proposed = await write(proposer, d.generation.resolution, protocolAbi.resolution, "propose", [
    marketId,
    0, // YES
    keccak256(toBytes("local-alpha-evidence")),
    "ipfs://local-alpha-evidence",
  ]);
  const challengeEnd = BigInt(events(proposed, protocolAbi.resolution, "Proposed")[0]!.args.challengeEnd);
  const proposal = await wait("market PROPOSED", async () => {
    const found = await anonymous.getMarket(ref);
    return found.market.state === "PROPOSED" ? found : null;
  });
  assert.equal(proposal.proposal?.outcome, "YES");
  await alpha.waitForChainTime(challengeEnd);
  await write(keeper, d.generation.resolution, protocolAbi.resolution, "finalizeUnchallenged", [marketId]);
  await wait("market FINAL", async () => (await anonymous.getMarket(ref)).market.state === "FINAL");
  const distributed = await write(keeper, markets, protocolAbi.markets, "distributeFees", [marketId]);
  const feesEvent = events(distributed, protocolAbi.markets, "FeesDistributed")[0]!.args;
  const redeemed = await write(taker, markets, protocolAbi.markets, "redeem", [marketId]);
  const redeemEvent = events(redeemed, protocolAbi.markets, "PositionRedeemed")[0]!.args;

  // --- What the API shows must match the chain ----------------------------------------------------
  const fees = await wait("fees in the API", async () => (await anonymous.getFees(ref)).fees);
  assert.equal(fees.poolMicros, String(feesEvent.amount));
  assert.ok(BigInt(fees.poolMicros) > 0n);
  assert.equal(fees.keeperTip, String(feesEvent.keeperTip));
  assert.equal(fees.keeper.toLowerCase(), keeper.address.toLowerCase());
  assert.equal(
    ["treasury", "creator", "resolution", "keeperTip", "jurors", "bounty"].reduce(
      (sum, name) => sum + BigInt((fees as Record<string, any>)[name]),
      0n,
    ),
    BigInt(fees.poolMicros),
  );
  const final = await wait("FINAL market with distributed fees", async () => {
    const found = await anonymous.getMarket(ref);
    return found.market.feesDistributed ? found : null;
  });
  assert.equal(final.market.state, "FINAL");
  assert.equal(final.market.finalOutcome, "YES");
  const redeemedPosition = await wait("redemption in the API", async () => {
    const found = (await anonymous.getPositions({ address: taker.address })).items.find(
      (p) => p.marketId === ref.marketId,
    );
    return found && BigInt(found.redeemedPayoutMicros) > 0n ? found : null;
  });
  assert.equal(redeemedPosition.redeemedPayoutMicros, String(redeemEvent.payout));
  assert.equal(redeemedPosition.finalOutcome, "YES");
  assert.equal((await anonymous.getSuggestion(suggestionId)).status, "MARKET_CREATED");
  const consensus = (await anonymous.getConsensus(ref)).items.find((c) => c.windowId === window.windowId);
  assert.equal(consensus?.submissions, 2);
  assert.equal(consensus?.contaminated, false);

  // --- Rebuilding equals incremental indexing ------------------------------------------------------
  const indexed = await anonymous.getDeployment();
  const verification = await rebuildChainProjection(
    postgresProtocolIndexStore(alpha.indexerPool),
    d.deploymentId,
    { verify: true, workerId: "local-alpha-verify", reader: alpha.logReader },
  );
  assert.deepEqual(verification.differences, []);
  assert.ok(verification.eventCount > 0);
  assert.equal(indexed.index.stale, false);

  // --- The platform holds no key -------------------------------------------------------------------
  const actorSecrets = Object.values(accounts).map((a) => {
    const privateKey = (a as unknown as { getHdKey(): { privateKey: Uint8Array } }).getHdKey().privateKey;
    return toHex(privateKey).toLowerCase();
  });
  for (const name of ["api", "indexer", "worker"] as PlatformName[]) {
    const process = alpha.platform[name];
    assert.equal(process.exited(), false, name + " is still running");
    assert.doesNotThrow(() => assertNoRoleKeys(process.env), name + " configured environment");
    // The environment the kernel reports for the live process, where /proc exists.
    const live = await alpha.liveEnvironment(name);
    if (live) assert.doesNotThrow(() => assertNoRoleKeys(live), name + " live environment");
    for (const environment of [process.env, live ?? {}])
      for (const value of Object.values(environment))
        for (const secret of actorSecrets)
          assert.ok(!value.toLowerCase().includes(secret.slice(2)), name + " environment carries an actor key");
  }
  await assert.rejects(
    anonymous.createRfq({ marketId: ref.marketId, side: "YES", quantity: "1" }),
    (error: unknown) => error instanceof BlinkApiError && error.status === 401,
  );
}
