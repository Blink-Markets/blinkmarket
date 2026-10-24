import {
  presets,
  type ProtocolDeployment,
} from "../../packages/schemas/src/index.ts";
import type { Pool } from "pg";
export const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
export const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export function protocolManifest(deploymentId = "d1"): ProtocolDeployment {
  return {
    schema: "blink.deployment/2",
    deploymentId,
    chainId: 84532,
    deployer: address(1),
    treasury: address(2),
    shared: {
      faucet: address(3),
      busd: address(4),
      token: address(5),
      priceSource: address(6),
      governor: address(7),
      anchor: address(8),
    },
    generation: {
      index: 0,
      registry: address(9),
      jurors: address(10),
      markets: address(11),
      resolution: address(12),
      previousRegistry: null,
    },
    params: presets.alpha,
    governor: {
      votingDelay: 1,
      votingPeriod: 60,
      proposalThreshold: "0",
      quorumFraction: 4,
      adoptionDelay: 60,
    },
    tokenPriceMicros: 1000000,
    contracts: {},
    startBlock: 10,
    releaseCommit: "0".repeat(40),
  };
}
export async function seedProtocolDeployment(
  db: Pick<Pool, "query">,
  id = "d1",
  manifest = protocolManifest(id),
) {
  await db.query(
    "INSERT INTO markets.protocol_deployments(deployment_id,manifest,verified_at) VALUES($1,$2,clock_timestamp()) ON CONFLICT DO NOTHING",
    [id, manifest],
  );
  return manifest;
}

// Public-read service fixtures use these fields until Tasks 7/10 replace their v0.1 response shape.
export function readMarket(id = 1, patch: Record<string, unknown> = {}) {
  return {
    marketId: String(id),
    creator: address(1),
    class: "A",
    state: "OPEN",
    templateId: hash(99),
    specHash: hash(id),
    specUri: "memory:spec",
    replay: true,
    openAt: 0,
    closeAt: 4102444800,
    proposalDeadline: 4102445000,
    hardDeadline: 4102446000,
    maxPairs: "10000",
    mintedPairs: "0",
    escrowMicros: "0",
    feePoolMicros: "0",
    finalOutcome: null,
    feesDistributed: false,
    creationChallenged: false,
    createdBlockNumber: String(id),
    createdTxHash: hash(10),
    challengeSeconds: 120,
    maxTakerShares: "500",
    ...patch,
  };
}
export async function seedReadMarket(
  db: { query(sql: string, params?: any[]): Promise<any> },
  deploymentId: string,
  id = 1,
  patch: Record<string, unknown> = {},
) {
  await seedProtocolDeployment(db as Pick<Pool, "query">, deploymentId);
  await db.query(
    "INSERT INTO protocol.markets(deployment_id,key,data,as_of_block_hash) VALUES($1,$2,$3,decode($4,'hex'))",
    [deploymentId, String(id), readMarket(id, patch), hash(10).slice(2)],
  );
}
export async function seedReadMaker(
  db: { query(sql: string, params?: any[]): Promise<any> },
  deploymentId: string,
  patch: Record<string, unknown> = {},
) {
  await seedProtocolDeployment(db as Pick<Pool, "query">, deploymentId);
  const data = {
    address: address(1),
    freeMicros: "1000000000",
    epoch: "3",
    ...patch,
  };
  await db.query(
    "INSERT INTO protocol.makers(deployment_id,key,data,as_of_block_hash) VALUES($1,$2,$3,decode($4,'hex'))",
    [deploymentId, data.address, data, hash(10).slice(2)],
  );
}
