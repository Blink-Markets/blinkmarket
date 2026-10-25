import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  toBytes,
  type Abi,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
} from "viem";
import { buildApi } from "../../apps/api/src/server.ts";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.ts";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.ts";
import {
  protocolAbi as typedAbi,
  type ProtocolContractName,
} from "../../packages/adapters/src/protocol-abi.ts";
import { protocolLogReader } from "../../packages/adapters/src/protocol-log-reader.ts";
import {
  postgresProtocolIndexStore,
  postgresProtocolReader,
} from "../../packages/adapters/src/protocol-index-store.ts";
import { postgresContentStore } from "../../packages/adapters/src/content-store.ts";
import { fileObjectStore } from "../../packages/adapters/src/file-object-store.ts";
import { loadProtocolDeployment } from "../../packages/adapters/src/deployment-registry.ts";
import { postgresMarketReadStore } from "../../packages/adapters/src/market-read-store.ts";
import { postgresRfqStore } from "../../packages/adapters/src/rfq-store.ts";
import { viemSignatureVerifier } from "../../packages/adapters/src/signature-verifier.ts";
import { createChainIndexer } from "../../packages/application/src/chain-indexer.ts";
import { createIdentityService } from "../../packages/application/src/identity.ts";
import { createMarketReadService } from "../../packages/application/src/market-read.ts";
import { createRfqService } from "../../packages/application/src/rfq-relay.ts";
import { quoteTypes, type QuoteFields } from "../../packages/schemas/src/index.ts";
import { createBlinkClient } from "../../packages/client/src/index.ts";
import { deployAlphaProtocol, startAnvil } from "./anvil.ts";
import { contractWalletArtifacts } from "./contract-wallet.ts";
import { createTestDatabase } from "./database.ts";
import { seedProtocolDeployment } from "./protocol-index.ts";

export const protocolAbi = typedAbi as unknown as Record<ProtocolContractName, Abi>;
export type Who =
  | "admin"
  | "maker"
  | "proposer"
  | "arbiter"
  | "taker"
  | "taker2"
  | "keeper"
  | "trader";
const SYNC_LOOP_MS = 150;

/** The tuple fillQuote and the EIP-712 message take. */
export const quoteStruct = (q: QuoteFields) => ({
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

/**
 * Anvil + the real protocol generation + a PGlite database with every migration + the chain
 * indexer + the real API (identity and RFQ relay, ECDSA and ERC-1271 checked on chain). Only used
 * by the anvil suites. The API runs as the database's default role here; least privilege is
 * covered by the unit and postgres suites.
 */
export async function startRfqStack() {
  const anvil = await startAnvil();
  const t = await createTestDatabase();
  try {
    const d = await deployAlphaProtocol(anvil);
    await seedProtocolDeployment(t.pool, d.deploymentId, d);
    const logs = protocolLogReader(anvil.publicClient as PublicClient, d);
    const store = postgresProtocolIndexStore(t.pool);
    const publicReader = postgresProtocolReader(t.pool, d.deploymentId);
    const indexerFor = (rangeSize?: number) =>
      createChainIndexer({
        store,
        reader: { ...logs, finalized: async () => null },
        deploymentId: d.deploymentId,
        marketAddress: d.generation.markets,
        deploymentBlock: BigInt(d.startBlock),
        workerId: "rfq-stack",
        ...(rangeSize === undefined ? {} : { rangeSize }),
      });
    // One block at a time until the generation exists, as the protocol indexer suite does.
    const catchUp = indexerFor(1);
    for (
      let n = d.startBlock;
      n <= Number(await anvil.publicClient.getBlockNumber());
      n++
    )
      await catchUp.syncOnce();
    const indexer = indexerFor();
    const clock = { seconds: 0 };
    // One pass at a time: the background loop and a test step must not hold the lease together.
    let queue: Promise<unknown> = Promise.resolve();
    const sync = () => {
      const pass = queue.then(async () => {
        const result = await indexer.syncOnce();
        if (result.gateReason)
          throw new Error("INDEXER_GATED: " + result.gateReason);
        clock.seconds = Number((await anvil.publicClient.getBlock()).timestamp);
      });
      queue = pass.catch(() => undefined);
      return pass;
    };
    await sync();

    const verifier = viemSignatureVerifier(anvil.publicClient);
    const identity = createIdentityService(
      postgresIdentityStore(t.pool),
      identityCrypto,
      "https://blink.example",
      { verifier, reader: publicReader },
    );
    const rfq = createRfqService({
      store: postgresRfqStore(t.pool, d.deploymentId, () => clock.seconds),
      identity,
      reader: publicReader,
      verifier,
      deployment: {
        markets: d.generation.markets,
        maxFillShares: d.params.maxFillShares,
      },
      // Chain time as of the last sync: quotes expire by block timestamp.
      now: () => clock.seconds,
    });
    // The real read routes (Task 7): deployment, markets, spec, positions and the rest.
    const specDirectory = await mkdtemp(join(tmpdir(), "blink-rfq-stack-"));
    const reads = createMarketReadService({
      store: postgresMarketReadStore(t.pool),
      reader: publicReader,
      content: postgresContentStore(t.pool, fileObjectStore(specDirectory)),
      deployment: () => loadProtocolDeployment(t.pool, d.deploymentId),
    });
    const api = buildApi({ identity, services: [rfq, reads] });
    api.log.level = "silent";
    await api.listen({ port: 0, host: "127.0.0.1" });
    const apiUrl = "http://127.0.0.1:" + (api.server.address() as AddressInfo).port;

    // Keeps the index fresh while a test step is waiting on something else.
    let syncing = true;
    let syncError: unknown;
    const loop = (async () => {
      while (syncing) {
        try {
          await sync();
        } catch (error) {
          syncError = error;
          return;
        }
        await new Promise((r) => setTimeout(r, SYNC_LOOP_MS));
      }
    })();

    const write = async (
      who: LocalAccount,
      address: string,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
    ) => {
      const receipt = await anvil.publicClient.waitForTransactionReceipt({
        hash: await anvil.wallet(who).writeContract({
          address: address as Hex,
          abi,
          functionName,
          args,
          gas: 5_000_000n,
        }),
      });
      if (receipt.status !== "success") throw new Error(functionName + " reverted");
      return receipt;
    };
    const markets = d.generation.markets as Hex;
    const read = <T = unknown>(
      address: string,
      abi: Abi,
      functionName: string,
      args: readonly unknown[] = [],
    ) =>
      anvil.publicClient.readContract({
        address: address as Hex,
        abi,
        functionName,
        args,
      } as never) as Promise<T>;
    const mread = <T = any>(functionName: string, args: readonly unknown[] = []) =>
      read<T>(markets, protocolAbi.markets, functionName, args);

    /** The calls an account makes to join the protocol as `role`; sent by the account itself. */
    const onboardingCalls = (role: number | null) => {
      const calls: [string, Abi, string, readonly unknown[]][] = [
        [d.shared.faucet, protocolAbi.faucet, "claim", []],
        ...[d.generation.registry, markets, d.generation.resolution].map(
          (spender): [string, Abi, string, readonly unknown[]] => [
            d.shared.busd,
            erc20Abi as Abi,
            "approve",
            [spender, 2n ** 256n - 1n],
          ],
        ),
        [d.generation.registry, protocolAbi.registry, "register", []],
      ];
      if (role !== null)
        calls.push([
          d.generation.registry,
          protocolAbi.registry,
          "joinRole",
          [role, BigInt(d.params.minRoleStake)],
        ]);
      return calls;
    };
    return {
      anvil,
      d,
      t,
      api,
      apiUrl,
      publicReader,
      markets,
      write,
      read,
      mread,
      sync,
      /** Pauses the background loop and returns once it has stopped. */
      async stopSync() {
        syncing = false;
        await loop;
        if (syncError) throw syncError;
      },
      /** An EOA joins the protocol (faucet, approvals, register, role). */
      async onboard(who: Who, role: number | null) {
        for (const [address, abi, fn, args] of onboardingCalls(role))
          await write(anvil.accounts[who], address, abi, fn, args);
      },
      /** A contract wallet does the same through its owner. */
      async onboardWallet(wallet: Address, owner: LocalAccount, role: number | null) {
        for (const [address, abi, fn, args] of onboardingCalls(role))
          await write(
            owner,
            wallet,
            contractWalletArtifacts().wallet.abi,
            "execute",
            [address, 0n, encodeFunctionData({ abi, functionName: fn, args } as never)],
          );
      },
      async depositMaker(who: Who, micros: bigint) {
        await write(anvil.accounts[who], markets, protocolAbi.markets, "depositMaker", [micros]);
      },
      /** createMarket is bounded by what the jurors have at stake, so one arbiter stakes first. */
      async stakeJurors() {
        const { arbiter } = anvil.accounts;
        for (const [address, abi, fn, args] of onboardingCalls(null))
          await write(arbiter, address, abi, fn, args);
        const stake = 1000n * 10n ** 18n;
        await write(arbiter, d.shared.token, erc20Abi as Abi, "approve", [d.generation.jurors, stake]);
        await write(arbiter, d.generation.jurors, protocolAbi.jurors, "stake", [stake]);
      },
      /** A class-B market, open now, closing `closeIn` seconds from now. */
      async createOpenMarket(closeIn = 600n) {
        const parserHash = keccak256(toBytes("rfq-stack-parser"));
        const specHash = keccak256(toBytes("rfq-stack-spec-" + Math.random()));
        const templateReceipt = await write(
          anvil.accounts.admin,
          markets,
          protocolAbi.markets,
          "registerTemplate",
          [0, parserHash, "ipfs://template"],
        );
        const templateEvent = (
          await logs.logs("", templateReceipt.blockNumber, templateReceipt.blockNumber)
        ).find((e) => e.name === "TemplateRegistered")!;
        const now = (await anvil.publicClient.getBlock()).timestamp;
        const created = await write(
          anvil.accounts.admin,
          markets,
          protocolAbi.markets,
          "createMarket",
          [
            {
              templateId: templateEvent.args.templateId as Hex,
              specHash,
              specURI: "ipfs://spec",
              replay: true,
              closeAt: now + closeIn,
              proposalDeadline: now + closeIn + 100n,
              hardDeadline: now + closeIn + 600n,
              maxPairs: 100n,
            },
          ],
        );
        const marketId = BigInt(
          (await logs.logs("", created.blockNumber, created.blockNumber)).find(
            (e) => e.name === "MarketCreated",
          )!.args.marketId as string,
        );
        const m = await mread("getMarket", [marketId]);
        await anvil.setNextTimestamp(m.openAt);
        await write(anvil.accounts.keeper, markets, protocolAbi.markets, "open", [marketId]);
        return {
          marketId,
          specHash,
          parserHash,
          closeAt: BigInt(m.closeAt),
        };
      },
      /** Propose, wait out the challenge window and finalize, then distribute fees. */
      async resolve(market: { marketId: bigint; parserHash: Hex; closeAt: bigint }) {
        await anvil.setNextTimestamp(market.closeAt);
        await write(anvil.accounts.proposer, d.generation.resolution, protocolAbi.resolution, "propose", [
          market.marketId,
          0,
          market.parserHash,
          "ipfs://evidence",
        ]);
        await anvil.setNextTimestamp(
          (await anvil.publicClient.getBlock()).timestamp +
            BigInt(d.params.resultChallengeWindow[0]),
        );
        await write(anvil.accounts.keeper, d.generation.resolution, protocolAbi.resolution, "finalizeUnchallenged", [market.marketId]);
        await write(anvil.accounts.keeper, markets, protocolAbi.markets, "distributeFees", [market.marketId]);
      },
      /** A quote fields object for `maker` (a signer or a wallet address); chain time based. */
      async quoteFor(
        market: { marketId: bigint; specHash: Hex },
        maker: Address,
        taker: Address,
        patch: Partial<QuoteFields> = {},
      ): Promise<QuoteFields> {
        const now = (await anvil.publicClient.getBlock()).timestamp;
        const epoch = await mread("makerEpoch", [maker]);
        return {
          marketId: String(market.marketId),
          specHash: market.specHash,
          maker: maker.toLowerCase(),
          taker: taker.toLowerCase(),
          side: "0",
          quantity: "10",
          priceBps: "4000",
          validAfter: String(now),
          expiresAt: String(now + 60n),
          nonce: String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))),
          epoch: String(epoch),
          ...patch,
        };
      },
      sign(signer: LocalAccount, q: QuoteFields) {
        return signer.signTypedData({
          domain: {
            name: "Blink RFQ",
            version: "0.2",
            chainId: 84532,
            verifyingContract: markets,
          },
          types: quoteTypes,
          primaryType: "Quote",
          message: quoteStruct(q),
        });
      },
      /** An API key by wallet proof, the way an agent gets one; the account must be registered and indexed. */
      async keyFor(signer: LocalAccount, address: string = signer.address) {
        const client = createBlinkClient(apiUrl);
        const challenge = await client.createWalletChallenge({
          address: address.toLowerCase(),
          action: "issue",
        });
        const issued = await client.verifyWallet({
          challengeId: challenge.challengeId,
          signature: await signer.signMessage({ message: challenge.message }),
        });
        if (!("apiKey" in issued)) throw new Error("NO_API_KEY");
        return issued.apiKey;
      },
      async close() {
        syncing = false;
        await loop.catch(() => undefined);
        await api.close().catch(() => undefined);
        await rm(specDirectory, { recursive: true, force: true });
        await t.close().catch(() => undefined);
        await anvil.stop();
      },
    };
  } catch (error) {
    await t.close().catch(() => undefined);
    await anvil.stop();
    throw error;
  }
}
export type RfqStack = Awaited<ReturnType<typeof startRfqStack>>;
