import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { buildApi } from "../../apps/api/src/server.js";
import { createTokenBucket } from "../../apps/api/src/rate-limit.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.js";
import { postgresSignerStore } from "../../packages/adapters/src/signing-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import {
  postgresReservationReader,
  postgresTradingStore,
} from "../../packages/adapters/src/trading-store.js";
import { createSnapshotReader } from "../../packages/application/src/forecasts.js";
import { createRfqService } from "../../packages/application/src/rfq.js";
import {
  createReservationQuoteCheck,
  createSignerService,
} from "../../packages/application/src/signer.js";
import type {
  ChainHead,
  ChainSnapshotReader,
  RestrictedSigner,
  SignResult,
  TradingChainView,
} from "../../packages/ports/src/index.js";
import { createTestDatabase, bindWallet, inviteAgent } from "./database.js";
import { poolAs } from "./research.js";
import {
  seedDeployment,
  sha256Hex,
  testAccounts,
  testManifest,
  testSpecHash,
} from "./signer-fixture.js";

export const DEPLOYMENT = "rfq-test";
export const HEAD_NUMBER = 100n;
/** The canonical head block time every fixture quote is anchored to. */
export const HEAD_TS = 1_000_000n;
export const CLOSE_AT = HEAD_TS + 100_000n;
export const FREE_MICROS = 1_000_000_000n;
export const blockHash = (n: bigint | number) =>
  ("0x" + BigInt(n).toString(16).padStart(64, "0")) as Hex;
export const digestOf = (n: number) =>
  ("0x" + (0x900 + n).toString(16).padStart(64, "0")) as Hex;
export const SIGNER_TOKEN = "api-signer-token";

export const rfqBody = {
  deploymentId: DEPLOYMENT,
  marketId: "1",
  side: "YES",
  quantity: "10",
  maxCostMicros: "6500000",
};

export type TestDb = Awaited<ReturnType<typeof createTestDatabase>>;

/** The chain as the RFQ sees it: a scriptable head and one contract view. */
export function fakeTradingChain() {
  const state = {
    head: {
      number: HEAD_NUMBER,
      hash: blockHash(HEAD_NUMBER),
      timestamp: HEAD_TS,
    } as ChainHead,
    view: {
      market: {
        state: "OPEN",
        paused: false,
        closeAt: CLOSE_AT,
        maxPairs: 10_000n,
        maxTakerShares: 500n,
        totalMintedPairs: 0n,
      },
      globalTradingPaused: false,
      makerFreeMicros: FREE_MICROS,
      makerEpoch: 3n,
      takerAllowed: true,
      cumulativeTakerShares: 0n,
    } as TradingChainView,
    headFails: false,
    readFails: false,
    headCalls: 0,
    readCalls: 0,
    reads: [] as { blockHash: Hex; marketId: bigint; taker: Hex }[],
    /** Runs inside read(), after it was asked and before it answers. */
    onRead: null as null | (() => Promise<void>),
  };
  const reader: ChainSnapshotReader = {
    async chainId() {
      return 84532;
    },
    async head() {
      state.headCalls += 1;
      if (state.headFails) throw new Error("RPC_DOWN");
      return state.head;
    },
    async read(input) {
      state.readCalls += 1;
      state.reads.push(input);
      await state.onRead?.();
      if (state.readFails) throw new Error("RPC_DOWN");
      return state.view;
    },
  };
  return { state, reader };
}

/**
 * The real signer service on its own role, reached without HTTP. `faults` decides what the
 * transport does: it can lose the request, or lose the answer of a request the signer completed.
 */
export function inProcessSigner(
  service: ReturnType<typeof createSignerService>,
) {
  const faults = {
    loseRequest: false,
    loseAnswer: false,
    /** Resolves before the signer is called, to hold a request in flight. */
    gate: null as null | Promise<void>,
  };
  const calls: { signRequestId: string; expectedRequestHash: string }[] = [];
  const signer: RestrictedSigner = {
    async sign(input) {
      calls.push(input);
      if (faults.gate) await faults.gate;
      if (faults.loseRequest)
        return { state: "UNKNOWN", code: "SIGNER_TIMEOUT" };
      const { status, body } = await service.handle(SIGNER_TOKEN, input);
      if (faults.loseAnswer)
        return { state: "UNKNOWN", code: "SIGNER_TIMEOUT" };
      if (status === 200 && body.state === "SIGNED")
        return {
          state: "SIGNED",
          artifactId: String(body.artifactId),
          artifactHash: String(body.artifactHash),
          ...(typeof body.signature === "string"
            ? { signature: body.signature }
            : {}),
        } satisfies SignResult;
      if (status === 422 && body.state === "REJECTED")
        return { state: "REJECTED", code: String(body.code) };
      return { state: "UNKNOWN", code: String(body.code ?? "SIGNER_ERROR") };
    },
  };
  return { signer, faults, calls };
}

type Queryable = { query(sql: string, params?: unknown[]): Promise<unknown> };
type Invited = { agentId: string; operatorId: string; keyId: string };

/** Both platform forecasters answered `a` and `b` in a window that closed `hoursAgo` hours ago. */
export async function seedSnapshotRows(
  db: Queryable,
  agents: { a: Invited; b: Invited },
  input: { a?: number; b?: number; hoursAgo?: number; marketId?: number } = {},
) {
  const windowId = randomUUID();
  for (const [agent, role] of [
    [agents.a, "FORECASTER_A"],
    [agents.b, "FORECASTER_B"],
  ] as const)
    await db.query(
      `INSERT INTO forecasts.platform_agents(agent_id,role,model,prompt_hash,policy_version)
      VALUES($1,$2,'fixture',decode(repeat('66',32),'hex'),'v1') ON CONFLICT DO NOTHING`,
      [agent.agentId, role],
    );
  await db.query(
    `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
    SELECT $1,$2,$3,'DAILY',d,d-interval '30 minutes',d
    FROM (SELECT blink.now()-make_interval(hours=>$4::int) AS d) stamp`,
    [windowId, DEPLOYMENT, input.marketId ?? 1, input.hoursAgo ?? 1],
  );
  for (const [agent, probability] of [
    [agents.a, input.a ?? 0.6],
    [agents.b, input.b ?? 0.6],
  ] as const)
    await db.query(
      `INSERT INTO forecasts.submissions(id,window_id,agent_id,operator_id,key_id,probability,evidence_ids,rationale,agent_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixture','v1')`,
      [
        randomUUID(),
        windowId,
        agent.agentId,
        agent.operatorId,
        agent.keyId,
        probability,
        [randomUUID()],
      ],
    );
  return windowId;
}
export async function seedSnapshot(
  t: TestDb,
  input: { a?: number; b?: number; hoursAgo?: number; marketId?: number } = {},
) {
  const invite = (name: string) =>
    inviteAgent(t, {
      name: name + randomUUID().slice(0, 8),
      scopes: ["forecast:write"],
    });
  const agents = {
    a: await invite("forecaster-a-"),
    b: await invite("forecaster-b-"),
  };
  await t.db.exec("RESET ROLE");
  return seedSnapshotRows(t.db, agents, input);
}

/** The indexer's cursor (and its block) as the RFQ reads it; `synced_at` is now. */
export async function writeCursor(
  db: Queryable,
  cursor: {
    number: bigint;
    timestamp: bigint;
    headNumber?: bigint;
    gate?: string | null;
    finalized?: bigint | null;
  },
) {
  await db.query(
    `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
    VALUES($1,$2,decode($3,'hex'),decode($4,'hex'),$5,true) ON CONFLICT DO NOTHING`,
    [
      DEPLOYMENT,
      cursor.number.toString(),
      blockHash(cursor.number).slice(2),
      blockHash(cursor.number - 1n).slice(2),
      cursor.timestamp.toString(),
    ],
  );
  await db.query(
    `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,finalized_number,synced_at,gate_reason)
    VALUES($1,$2,decode($3,'hex'),$4,$5,$6,blink.now(),$7)
    ON CONFLICT (deployment_id) DO UPDATE SET block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash,
      block_timestamp=EXCLUDED.block_timestamp, head_number=EXCLUDED.head_number,
      finalized_number=EXCLUDED.finalized_number, synced_at=EXCLUDED.synced_at, gate_reason=EXCLUDED.gate_reason`,
    [
      DEPLOYMENT,
      cursor.number.toString(),
      blockHash(cursor.number).slice(2),
      cursor.timestamp.toString(),
      (cursor.headNumber ?? cursor.number).toString(),
      cursor.finalized === undefined ? "90" : cursor.finalized?.toString(),
      cursor.gate ?? null,
    ],
  );
}
/** One OPEN market, the maker's free balance and epoch, and a fresh cursor at the head. */
export async function seedChainState(db: Queryable) {
  await db.query(
    `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,
      challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
    VALUES($1,1,decode($2,'hex'),'file://spec','REPLAY',$3,$4,$5,120,10000,500,'OPEN',1,decode($6,'hex'),decode($6,'hex'))`,
    [
      DEPLOYMENT,
      testSpecHash.slice(2),
      CLOSE_AT.toString(),
      (CLOSE_AT + 1000n).toString(),
      (CLOSE_AT + 5000n).toString(),
      blockHash(1).slice(2),
    ],
  );
  await db.query(
    `INSERT INTO chain.maker_state(deployment_id,free_balance_micros,epoch,as_of_block_hash)
    VALUES($1,$2,3,decode($3,'hex'))`,
    [DEPLOYMENT, FREE_MICROS.toString(), blockHash(HEAD_NUMBER).slice(2)],
  );
  await writeCursor(db, { number: HEAD_NUMBER, timestamp: HEAD_TS });
}
/** A wallet bound to an agent without running the signature challenge. */
export async function bindWalletRows(
  db: Queryable,
  agent: { agentId: string; keyId: string },
  address: string,
) {
  const challengeId = randomUUID();
  await db.query(
    `INSERT INTO identity.wallet_challenges
    (id,key_id,agent_id,address,chain_id,origin,nonce_hash,message,issued_at,expires_at,consumed_at)
    VALUES ($1,$2,$3,decode($4,'hex'),84532,'https://blink.example',decode($5,'hex'),'test binding',
      now(),now() + interval '5 minutes',now())`,
    [
      challengeId,
      agent.keyId,
      agent.agentId,
      address.slice(2),
      randomUUID().replaceAll("-", "").repeat(2),
    ],
  );
  await db.query(
    `INSERT INTO identity.wallet_bindings(agent_id,chain_id,address,challenge_id)
    VALUES ($1,84532,decode($2,'hex'),$3)`,
    [agent.agentId, address.slice(2), challengeId],
  );
}

export interface WorldOptions {
  manifest?: Parameters<typeof testManifest>[0];
  /** Rate limiter capacity; the default is generous so only the limiter test meets it. */
  limiter?: { capacity: number; refillPerSecond: number };
  snapshot?: boolean;
}

/**
 * The trading stack over one PGlite database: the real RFQ service and API on `blink_api`, the real
 * signer on `blink_signer` with the reservation check, a scripted chain, and seeded chain,
 * forecast and identity rows.
 */
export async function tradingWorld(options: WorldOptions = {}) {
  const t = await createTestDatabase();
  const manifest = testManifest({
    deploymentId: DEPLOYMENT,
    ...options.manifest,
  });
  await seedDeployment(t.db, manifest);
  const owner = async <T>(work: () => Promise<T>) => {
    await t.db.exec("RESET ROLE");
    return work();
  };
  const query = <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => owner(async () => (await t.db.query<R>(sql, params)).rows);

  const chain = fakeTradingChain();
  const setCursor = (cursor: Parameters<typeof writeCursor>[1]) =>
    owner(() => writeCursor(t.db, cursor));
  await owner(() => seedChainState(t.db));
  if (options.snapshot !== false) await seedSnapshot(t);

  const taker = await inviteAgent(t, {
    name: "taker",
    scopes: ["trade:quote"],
  });
  await bindWallet(t, taker.agentId, testAccounts.taker.address);
  const taker2 = await inviteAgent(t, {
    name: "taker2",
    scopes: ["trade:quote"],
  });
  await bindWallet(t, taker2.agentId, testAccounts.taker2.address);
  const admin = await inviteAgent(t, {
    name: "admin",
    scopes: ["admin", "trade:quote"],
  });
  const noWallet = await inviteAgent(t, {
    name: "no-wallet",
    scopes: ["trade:quote"],
  });
  const noScope = await inviteAgent(t, {
    name: "no-scope",
    scopes: ["forecast:write"],
  });
  await bindWallet(t, noScope.agentId, testAccounts.keeper.address);
  // A second key of the taker's agent, to show that visibility follows the agent.
  const apiPool = poolAs(t, "blink_api");
  const tradingStore = postgresTradingStore(apiPool);

  let clock = Number(HEAD_TS) * 1000 + 1000;
  const signerService = createSignerService({
    store: postgresSignerStore(poolAs(t, "blink_signer")),
    keys: { maker: testAccounts.maker },
    rpc: {
      chainId: async () => 84532,
      estimateGas: async () => {
        throw new Error("UNUSED");
      },
      baseFeePerGas: async () => 0n,
      maxPriorityFeePerGas: async () => 0n,
      pendingNonce: async () => 0n,
      l1Fee: async () => 0n,
    },
    deployment: manifest,
    callers: [
      {
        name: "quote-api",
        tokenSha256: sha256Hex(SIGNER_TOKEN),
        roles: ["maker"],
      },
    ],
    policy: {
      l1FeeMode: "local-none",
      perTxCapWei: 200_000_000_000_000n,
      dailyCapWei: 2_000_000_000_000_000n,
    },
    encodeCall: encodeAllowedCall,
    quoteCheck: createReservationQuoteCheck(postgresReservationReader()),
    now: () => clock,
  });
  const signing = inProcessSigner(signerService);

  const limiterOptions = options.limiter ?? {
    capacity: 1000,
    refillPerSecond: 1000,
  };
  let limiterNow = 0;
  const limiter = createTokenBucket({
    ...limiterOptions,
    now: () => limiterNow,
  });
  let nonce = 1n;
  const service = createRfqService({
    store: tradingStore,
    crypto: identityCrypto,
    signer: signing.signer,
    chain: chain.reader,
    snapshots: createSnapshotReader(postgresForecastStore(apiPool)),
    encodeCall: encodeAllowedCall,
    deploymentId: DEPLOYMENT,
    random: () => nonce++,
    limiter,
  });
  const app = buildApi({ services: [service] });
  app.log.level = "silent";

  const post = (
    key: string,
    body: Record<string, unknown> = rfqBody,
    agent: { apiKey: string } = taker,
  ) =>
    app.inject({
      method: "POST",
      url: "/v1/rfqs",
      headers: {
        authorization: "Bearer " + agent.apiKey,
        "idempotency-key": key,
      },
      payload: body,
    });
  const get = (quoteId: string, agent?: { apiKey: string }) =>
    app.inject({
      method: "GET",
      url: "/v1/quotes/" + quoteId,
      headers: agent ? { authorization: "Bearer " + agent.apiKey } : {},
    });

  return {
    t,
    manifest,
    app,
    chain,
    signing,
    agents: { taker, taker2, admin, noWallet, noScope },
    post,
    get,
    query,
    owner,
    setCursor,
    tradingStore,
    apiPool,
    signerService,
    setSignerClock: (ms: number) => {
      clock = ms;
    },
    advanceLimiter: (ms: number) => {
      limiterNow += ms;
    },
    /** Moves blink.now() without sleeping. */
    async setDbClock(seconds: number) {
      await t.db.query(
        "SELECT set_config('blink.test_clock_offset_seconds',$1,false)",
        [String(seconds)],
      );
    },
    async close() {
      await app.close();
      await t.close();
    },
  };
}
export type TradingWorld = Awaited<ReturnType<typeof tradingWorld>>;
