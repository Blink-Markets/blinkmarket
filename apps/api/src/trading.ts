import { randomBytes } from "node:crypto";
import type pg from "pg";
import { createPublicClient, http, type Hex } from "viem";
import {
  createRfqService,
  createSnapshotReader,
  createTradingReadiness,
} from "@blink/application";
import {
  assertTradingInstalled,
  chainSnapshotReader,
  encodeAllowedCall,
  identityCrypto,
  postgresForecastStore,
  postgresTradingStore,
  signerClient,
} from "@blink/adapters";
import { DeploymentManifest } from "@blink/schemas";
import { createTokenBucket } from "./rate-limit.js";

// Each RPC call is bounded well below the database's idle-in-transaction timeout (10 s): the RFQ
// reads the chain while its admission transaction is open.
const RPC_TIMEOUT_MS = 3000;

/** The `trading` mode's RFQ service and the readiness that makes /v1/config and canTrade truthful. */
export async function tradingServices(
  pool: pg.Pool,
  config: {
    deploymentId: string;
    signerUrl: string;
    signerToken: string;
    rpcUrl: string;
  },
) {
  await assertTradingInstalled(pool);
  const row = await pool.query(
    "SELECT manifest FROM markets.deployments WHERE id=$1",
    [config.deploymentId],
  );
  const manifest = DeploymentManifest.safeParse(row.rows[0]?.manifest);
  if (!manifest.success) throw new Error("DEPLOYMENT_MANIFEST_INVALID");
  const chain = chainSnapshotReader({
    client: createPublicClient({
      transport: http(config.rpcUrl, {
        timeout: RPC_TIMEOUT_MS,
        retryCount: 0,
      }),
      cacheTime: 0,
    }),
    market: manifest.data.contracts.BlinkMarket as Hex,
  });
  const chainId = await chain.chainId();
  if (chainId === 8453) throw new Error("MAINNET_REFUSED");
  if (chainId !== 84532) throw new Error("RPC_CHAIN_MISMATCH");
  const store = postgresTradingStore(pool);
  const snapshots = createSnapshotReader(postgresForecastStore(pool));
  return {
    rfq: createRfqService({
      store,
      crypto: identityCrypto,
      signer: signerClient({
        url: config.signerUrl,
        token: config.signerToken,
      }),
      chain,
      snapshots,
      encodeCall: encodeAllowedCall,
      deploymentId: config.deploymentId,
      random: () => BigInt("0x" + randomBytes(32).toString("hex")),
      // Spec 9.1: 2 requests per second per API key with a burst of 5.
      limiter: createTokenBucket({ capacity: 5, refillPerSecond: 2 }),
    }),
    readiness: createTradingReadiness({
      store,
      snapshots,
      deploymentId: config.deploymentId,
    }),
  };
}
