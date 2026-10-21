import type { Pool } from "pg";
import { TX_DISPATCH_MAX_ATTEMPTS, type JobType } from "@blink/domain";
import type { JobHandler, JobQueue } from "@blink/ports";
import {
  postgresFaucetStore,
  postgresKeeperStore,
  postgresDispatchStore,
  signerClient,
  viemDispatchRpc,
  executionChainReader,
  loadChainDeployment,
  assertProductionClock,
} from "@blink/adapters";
import {
  createFaucetMintHandler,
  createKeeperHandler,
  createExecutionDispatcher,
  createTxDispatcher,
  createTxDispatchHandler,
  schedulePeriodic,
} from "@blink/application";
import type { ExecutionConfig } from "./config.js";

export async function buildExecution(deps: {
  pool: Pool;
  queue: JobQueue;
  config: ExecutionConfig | null;
  /** Only the local Alpha harness shifts the business clock; the worker never passes this. */
  allowTestClock?: boolean;
}): Promise<{
  handlers: Partial<Record<JobType, JobHandler>>;
  tick(): Promise<void>;
}> {
  if (!deps.config) return { handlers: {}, tick: async () => {} };
  const { pool, queue, config } = deps;
  await assertProductionClock(pool, deps.allowTestClock ?? false);
  const deployment = await loadChainDeployment(pool, config.deploymentId);
  await pool.query("SELECT id FROM faucet.claims LIMIT 0");
  const reader = executionChainReader({
    url: config.rpcUrl,
    marketAddress: deployment.marketAddress,
  });
  await reader.assertChain();
  const signer = signerClient({
    url: config.signerUrl,
    token: config.signerToken,
  });
  const store = postgresDispatchStore(pool);
  const faucet = postgresFaucetStore(pool);
  const dispatcher = createExecutionDispatcher({
    dispatcher: createTxDispatcher({
      store,
      rpc: reader.guardDispatch(viemDispatchRpc({ url: config.rpcUrl })),
      signer,
    }),
    store,
    faucet,
    reader,
  });
  return {
    handlers: {
      "faucet.mint": createFaucetMintHandler({ store: faucet, signer }),
      "keeper.finalize": createKeeperHandler({
        store: postgresKeeperStore(pool),
        deploymentId: config.deploymentId,
        reader,
        signer,
      }),
      "tx.dispatch": createTxDispatchHandler(dispatcher),
    },
    async tick() {
      const now = new Date(
        (await pool.query("SELECT blink.now() AS now")).rows[0].now,
      );
      await schedulePeriodic(
        queue,
        "keeper.finalize",
        15_000,
        { deploymentId: config.deploymentId },
        now,
      );
      // A dead job never permits a second intent. Recover its persisted request/artifact in a new
      // time bucket after the normal bounded queue retries are exhausted.
      const { rows } = await pool.query(
        `SELECT 'faucet.mint' AS type,c.id::text AS id,'claimId' AS field FROM faucet.claims c
        JOIN signing.economic_intents i ON i.id=c.intent_id
        WHERE c.deployment_id=$1 AND c.state IN ('QUEUED','UNKNOWN') AND i.state NOT IN ('FINALIZED','FAILED')
          AND NOT EXISTS(SELECT 1 FROM operations.jobs j WHERE j.type='faucet.mint' AND j.payload->>'claimId'=c.id::text AND j.state IN ('QUEUED','LEASED'))
        UNION ALL
        SELECT 'tx.dispatch',c.intent_id::text,'intentId' FROM faucet.claims c
        JOIN signing.economic_intents i ON i.id=c.intent_id
        WHERE c.deployment_id=$1 AND c.state IN ('QUEUED','SUBMITTED','UNKNOWN') AND i.state IN ('FINALIZED','FAILED')
          AND NOT EXISTS(SELECT 1 FROM operations.jobs j WHERE j.type='tx.dispatch' AND j.payload->>'intentId'=i.id::text AND j.state IN ('QUEUED','LEASED'))
        UNION ALL
        SELECT 'tx.dispatch',i.id::text,'intentId' FROM signing.economic_intents i
        WHERE i.deployment_id=$1 AND i.state IN ('SIGNED','SUBMITTED','UNKNOWN','INCLUDED')
          AND EXISTS(SELECT 1 FROM signing.artifacts a JOIN signing.sign_requests r ON r.id=a.sign_request_id WHERE r.intent_id=i.id AND a.raw_transaction IS NOT NULL)
          AND NOT EXISTS(SELECT 1 FROM operations.jobs j WHERE j.type='tx.dispatch' AND j.payload->>'intentId'=i.id::text AND j.state IN ('QUEUED','LEASED'))`,
        [config.deploymentId],
      );
      for (const row of rows)
        await schedulePeriodic(
          queue,
          row.type,
          15_000,
          { [row.field]: row.id },
          now,
          row.type === "tx.dispatch" ? TX_DISPATCH_MAX_ATTEMPTS : 10,
        );
    },
  };
}
