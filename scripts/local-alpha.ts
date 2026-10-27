import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { erc20Abi, type Abi, type Hex, type LocalAccount } from "viem";
import { createBlinkClient } from "../packages/client/src/index.ts";
import { protocolAbi as typedAbi, type ProtocolContractName } from "../packages/adapters/src/protocol-abi.ts";
import {
  ALPHA_FORECAST_SCHEDULE,
  runCleanup,
  startAlphaPlatform,
  waitFor,
  type PlatformName,
  type PlatformProcess,
} from "./alpha/platform.ts";

// What used to live here stays importable from here.
export { ALPHA_FORECAST_SCHEDULE, runCleanup, waitFor, type PlatformName, type PlatformProcess };

/**
 * The infrastructure-only local alpha (P2 spec 2.1.3). It starts what the platform consists of and
 * nothing else: Anvil (chain 84532), the alpha protocol generation registered in a fresh PostgreSQL
 * database, and the real API, indexer and worker as separate processes. Those three get an explicit
 * environment (never the caller's), without any key, and `assertNoRoleKeys` is applied to each one
 * before it starts. The agents that exercise the protocol are the caller's: they hold Anvil's public
 * test keys inside their own process and reach the platform only through the public API,
 * `@blink/client` and the contracts. The platform itself is `startAlphaPlatform` in
 * `scripts/alpha/platform.ts` (this module starts its postgres backend and adds the helpers the
 * P2 scenario uses); P3's `pnpm alpha:autonomous` is built on that function.
 *
 * Time. The platform business clock is the database clock and the chain clock is Anvil's, and both
 * follow the wall clock: the alpha protocol periods (60 s windows) are short enough to wait out in
 * real time. A heartbeat mines one block per second so the chain head stays fresh for the indexer's
 * 30 second lag gate while Anvil would otherwise sit idle. Nothing sets the clock offset
 * (`blink.test_clock_offset_seconds`) or a chain timestamp: the offset is refused by the API and the
 * worker at startup, and shifting only one of the two clocks would make the index lag. A scenario
 * that must skip real time would have to move both by the same amount, and has no way to do that
 * against running services, so it waits with `waitForChainTime`.
 */

export const protocolAbi = typedAbi as unknown as Record<ProtocolContractName, Abi>;
export const ROLE = {
  CREATOR: 0,
  MAKER: 1,
  TAKER: 2,
  FORECASTER: 3,
  PROPOSER: 4,
  CHALLENGER: 5,
  JUROR: 6,
} as const;

export async function startLocalAlpha(
  options: { adminUrl?: string; forecastSchedule?: typeof ALPHA_FORECAST_SCHEDULE } = {},
) {
  const platform = await startAlphaPlatform({ backend: "postgres", ...options });
  const { anvil, deployment, apiUrl } = platform;
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
  const markets = deployment.generation.markets as Hex;
  /**
   * The calls an account makes to join the protocol as `role`: faucet claim, approvals, register
   * and the role stake. Sent by the account itself.
   */
  const onboardingCalls = (role: number | null) => {
    const { generation, shared, params } = deployment;
    const calls: [string, Abi, string, readonly unknown[]][] = [
      [shared.faucet, protocolAbi.faucet, "claim", []],
      ...[generation.registry, markets, generation.resolution].map(
        (spender): [string, Abi, string, readonly unknown[]] => [
          shared.busd,
          erc20Abi as Abi,
          "approve",
          [spender, 2n ** 256n - 1n],
        ],
      ),
      [generation.registry, protocolAbi.registry, "register", []],
    ];
    if (role !== null)
      calls.push([generation.registry, protocolAbi.registry, "joinRole", [role, BigInt(params.minRoleStake)]]);
    return calls;
  };

  return {
    anvil,
    deployment,
    accounts: platform.accounts,
    apiUrl,
    indexerUrl: platform.indexerUrl,
    workerUrl: platform.workerUrl,
    platform: platform.processes,
    markets,
    /** A login of the indexer role, for verifying the index against the journal. */
    indexerPool: platform.indexerPool,
    logReader: platform.logReader,
    failureLogs: platform.failureLogs,
    write,
    read: <T = unknown>(address: string, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
      anvil.publicClient.readContract({ address: address as Hex, abi, functionName, args } as never) as Promise<T>,
    /** Latest block timestamp. */
    chainNow: async () => (await anvil.publicClient.getBlock()).timestamp,
    /** Blocks keep coming (heartbeat), so this is a condition wait, not a sleep of a guessed length. */
    async waitForChainTime(seconds: bigint, timeoutMs = 300_000) {
      await waitFor(
        "chain time " + seconds,
        async () => (await anvil.publicClient.getBlock()).timestamp >= seconds,
        timeoutMs,
        250,
      );
    },
    onboardingCalls,
    /** An EOA joins the protocol; further roles need `joinRole` only. */
    async onboard(who: LocalAccount, role: number | null) {
      for (const [address, abi, fn, args] of onboardingCalls(role))
        await write(who, address, abi, fn, args);
    },
    /**
     * An API key by wallet proof, the way an agent gets one. It first waits until the index shows the
     * account registered (a challenge is rate limited per address, so it is requested once).
     */
    async apiKeyFor(signer: LocalAccount, address: string = signer.address) {
      const client = createBlinkClient(apiUrl);
      await waitFor("indexed registration of " + address, async () => {
        const account = await client.getAccount({ address: address.toLowerCase() });
        return account.registered && !account.index.stale;
      });
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
    /** The real environments of the running processes (Linux only), to prove no key got in. */
    async liveEnvironment(name: PlatformName): Promise<Record<string, string> | null> {
      const raw = await readFile(`/proc/${platform.processes[name].pid}/environ`, "utf8").catch(() => null);
      if (raw === null) return null;
      return Object.fromEntries(
        raw
          .split("\0")
          .filter(Boolean)
          .map((entry) => {
            const at = entry.indexOf("=");
            return [entry.slice(0, at), entry.slice(at + 1)];
          }),
      );
    },
    stop: platform.stop,
  };
}
export type LocalAlpha = Awaited<ReturnType<typeof startLocalAlpha>>;

// `node --import tsx scripts/local-alpha.ts` keeps the stack up for manual use until interrupted.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const alpha = await startLocalAlpha();
  console.log(
    JSON.stringify({ api: alpha.apiUrl, indexer: alpha.indexerUrl, worker: alpha.workerUrl, rpc: alpha.anvil.url }),
  );
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await alpha.stop();
}
