import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Abi, PublicClient } from "viem";
import { createUnitOfWork } from "./database.js";
import { verifyDeploymentOnChain } from "./deployment-verifier.js";

export async function registerVerifiedDeployment(
  pool: Pool,
  input: unknown,
  id: string,
  client: PublicClient,
  abis: { BlinkMarket: Abi; BlinkTestUSD: Abi },
  reason: string,
) {
  if (!reason.trim() || reason.length > 4000)
    throw new Error("REASON_REQUIRED");
  const checkedAt = new Date(); // Do not make a slow RPC/DB wait look like a fresh verification.
  const verified = await verifyDeploymentOnChain(input, id, client, abis);
  if (verified.manifest.tradingEnabled)
    throw new Error("TRADING_MUST_REMAIN_DISABLED");
  const manifest = verified.manifest,
    uow = createUnitOfWork(pool);
  return uow.run(async (context) => {
    const db = uow.client(context);
    await db.query(
      "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ($1,$2,decode($3,'hex')) ON CONFLICT(id) DO NOTHING",
      [id, manifest, manifest.contracts.BlinkMarket.slice(2)],
    );
    const existing = await db.query(
      "SELECT id FROM markets.deployments WHERE id=$1 AND manifest=$2::jsonb AND enabled FOR SHARE",
      [id, manifest],
    );
    if (!existing.rows.length) throw new Error("DEPLOYMENT_REGISTRY_CONFLICT");
    const verificationId = randomUUID();
    await db.query(
      "INSERT INTO markets.deployment_checks(id,deployment_id,block_hash,verified_at) VALUES ($1,$2,decode($3,'hex'),$4)",
      [verificationId, id, verified.asOfBlockHash.slice(2), checkedAt],
    );
    await db.query(
      "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ($1,current_user,'deployment.verified',$2,$3,$4)",
      [randomUUID(), id, reason, verificationId],
    );
    return {
      deploymentId: id,
      verificationId,
      asOfBlockHash: verified.asOfBlockHash,
      tradingEnabled: false,
    };
  });
}
