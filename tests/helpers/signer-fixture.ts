import { createHash, randomUUID } from "node:crypto";
import { mnemonicToAccount } from "viem/accounts";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import type { DeploymentManifest } from "../../packages/schemas/src/index.js";
import { signingIntentWriter } from "../../packages/adapters/src/signing-store.js";
import {
  intentRole,
  SIGNING_POLICY_VERSION,
  type IntentKind,
} from "../../packages/domain/src/signing-policy.js";
import {
  quoteRequestHash,
  transactionRequestHash,
} from "../../packages/application/src/signer.js";
import type { SigningSqlClient } from "../../packages/ports/src/index.js";

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
    deploymentId: "signer-test",
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

// --- database and request fixtures shared by the signer tests ---------------------------------
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
// Owner-level writes: the deployment row and the indexer-written chain projection the signer reads.
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
  const blockHash = "22".repeat(32);
  await db.query(
    `INSERT INTO chain.markets(deployment_id, market_id, spec_hash, spec_uri, mode, close_at, proposal_deadline,
      hard_deadline, challenge_seconds, max_pairs, max_taker_shares, state, created_block_number, created_tx_hash, as_of_block_hash)
    VALUES ($1, 1, decode($2, 'hex'), 'file://spec', 'REPLAY', $3, 3000, 4000, 120, 10000, 500, $4, 1, decode($5, 'hex'), decode($5, 'hex'))`,
    [
      input.deploymentId,
      testSpecHash.slice(2),
      input.closeAt ?? 2000,
      input.state ?? "OPEN",
      blockHash,
    ],
  );
  await db.query(
    `INSERT INTO chain.maker_state(deployment_id, free_balance_micros, epoch, as_of_block_hash)
    VALUES ($1, 1000000000, $2, decode($3, 'hex'))`,
    [input.deploymentId, input.epoch ?? 3, blockHash],
  );
}

// Creates an intent plus its sign request the way an API or worker would.
export async function prepareRequest(
  client: SigningSqlClient,
  manifest: DeploymentManifest,
  input: {
    kind: IntentKind;
    payload: Record<string, unknown>;
    intentId?: string;
    version?: number;
  },
) {
  const writer = signingIntentWriter();
  const role = intentRole(input.kind);
  const unsignedPayload = input.payload;
  const intentId =
    input.intentId ??
    (
      await writer.createIntent(client, {
        deploymentId: manifest.deploymentId,
        kind: input.kind,
        role,
        dedupeKey: randomUUID(),
        payload: unsignedPayload,
        createdBy: "test",
      })
    ).intentId;
  const requestHash =
    input.kind === "MAKER_QUOTE"
      ? quoteRequestHash(manifest, unsignedPayload)
      : transactionRequestHash(unsignedPayload);
  const { signRequestId } = await writer.createSignRequest(client, {
    intentId,
    role,
    unsignedPayload,
    requestHash,
    policyVersion: SIGNING_POLICY_VERSION,
    ...(input.version ? { artifactVersion: input.version } : {}),
  });
  return { intentId, signRequestId, requestHash };
}
