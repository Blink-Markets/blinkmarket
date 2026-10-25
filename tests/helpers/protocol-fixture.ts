import { seedReadMarket, seedReadMaker } from "./protocol-index.ts";
import { createHash } from "node:crypto";
import { mnemonicToAccount } from "viem/accounts";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import type { DeploymentManifest } from "../../packages/schemas/src/index.js";
// Public Anvil fixture mnemonic: never funded on a live network.
const mnemonic = "test test test test test test test test test test test junk";
const account = (addressIndex: number) =>
  mnemonicToAccount(mnemonic, { addressIndex });

// Same indices as tests/helpers/anvil.ts, so Anvil and unit tests agree on who is who.
export const testAccounts = {
  admin: account(0),
  maker: account(1),
  proposer: account(2),
  challenger: account(3),
  arbiter: account(4),
  minter: account(5),
  taker: account(6),
  taker2: account(7),
  keeper: account(8),
  trader: account(9),
};

export const testMarket = "0x00000000000000000000000000000000000000a1";
export const testToken = "0x00000000000000000000000000000000000000a2";

export function testManifest(
  overrides: Partial<DeploymentManifest> = {},
): DeploymentManifest {
  const hash = (text: string) => keccak256(toBytes(text));
  return {
    status: "DEPLOYED",
    chainId: 84532,
    deploymentId: "fixture-test",
    deploymentBlock: "1",
    contracts: { BlinkTestUSD: testToken, BlinkMarket: testMarket },
    artifacts: {
      abiHashes: {
        BlinkTestUSD: hash("abi-usd"),
        BlinkMarket: hash("abi-mkt"),
      },
      bytecodeHashes: {
        BlinkTestUSD: hash("code-usd"),
        BlinkMarket: hash("code-mkt"),
      },
      compiler: "0.8.30",
      gitCommit: "0".repeat(40),
      dependencies: { openzeppelin: "5.6.1" },
    },
    roles: {
      admin: testAccounts.admin.address,
      resultProposer: testAccounts.proposer.address,
      challenger: testAccounts.challenger.address,
      arbiter: testAccounts.arbiter.address,
      maker: testAccounts.maker.address,
      faucetMinter: testAccounts.minter.address,
    },
    parameters: {
      collateralDecimals: 6,
      quoteDefaultTtlSeconds: 30,
      quoteMaxTtlSeconds: 60,
      makerSpreadBps: 200,
      maxFillShares: "100",
      maxMarketPairs: "10000",
      maxTakerShares: "500",
    },
    tradingEnabled: true,
    ...overrides,
  };
}

// Public test accounts and observation fixtures.
export const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const privateKeyOf = (key: (typeof testAccounts)["maker"]) =>
  toHex(key.getHdKey().privateKey!);

export const testSpecHash = ("0x" + "11".repeat(32)) as Hex;
export const testQuote = {
  marketId: "1",
  specHash: testSpecHash,
  maker: testAccounts.maker.address,
  taker: testAccounts.taker.address,
  side: "0",
  quantity: "10",
  priceBps: "6000",
  validAfter: "1000",
  expiresAt: "1030",
  nonce: "7",
  epoch: "3",
};

type Db = { query(sql: string, params?: unknown[]): Promise<unknown> };
// Owner-level writes: the deployment row and the indexer-written chain projection used by infrastructure.
export async function seedDeployment(db: Db, manifest: DeploymentManifest) {
  await db.query(
    "INSERT INTO markets.deployments(id, manifest, market_address) VALUES ($1, $2::jsonb, decode($3, 'hex'))",
    [
      manifest.deploymentId,
      JSON.stringify(manifest),
      manifest.contracts.BlinkMarket.slice(2),
    ],
  );
}
export async function seedChain(
  db: Db,
  input: {
    deploymentId: string;
    closeAt?: number;
    epoch?: number;
    state?: string;
  },
) {
  await seedReadMarket(db, input.deploymentId, 1, {
    specHash: testSpecHash,
    specUri: "file://spec",
    closeAt: input.closeAt ?? 2000,
    state: input.state ?? "OPEN",
  });
  await seedReadMaker(db, input.deploymentId, {
    epoch: String(input.epoch ?? 3),
  });
}
