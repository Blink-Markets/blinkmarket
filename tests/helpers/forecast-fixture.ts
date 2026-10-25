import { randomBytes, randomUUID } from "node:crypto";
import type { LocalAccount } from "viem";
import { buildApi } from "../../apps/api/src/server.ts";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.ts";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.ts";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.ts";
import {
  createForecastService,
  createWindowScheduler,
} from "../../packages/application/src/forecasts.ts";
import { createIdentityService } from "../../packages/application/src/identity.ts";
import {
  NO_CONTENT_HASH,
  forecastTypedData,
  presets,
  type ForecastMessage,
  type ProtocolAccount,
  type ProtocolMarket,
  type ProtocolProposal,
  type RoleName,
} from "../../packages/schemas/src/index.ts";
import { bindWallet, createTestDatabase, inviteAgent } from "./database.ts";
import { testAccounts } from "./protocol-fixture.ts";
import { fakeProtocolReader } from "./protocol-reader.ts";
import { address, hash, protocolManifest } from "./protocol-index.ts";
import { fakeSignatureVerifier } from "./signature-verifier.ts";

/** The pinned database clock of these suites, in unix seconds. */
export const ORIGIN = Math.floor(Date.UTC(2026, 9, 26, 12) / 1000);
export const DEPLOYMENT = "d1";
const manifest = protocolManifest(DEPLOYMENT);
export const MARKETS = manifest.generation.markets;
export const ANCHOR = manifest.shared.anchor;
/** A contract wallet owned by testAccounts.trader. */
export const WALLET = address(0xc0de1);
export const CLOSE_AT = ORIGIN + 7200;

export const roleHolder = (
  who: string,
  roles: RoleName[] = ["FORECASTER"],
): ProtocolAccount => ({
  address: who.toLowerCase(),
  registered: true,
  roles: Object.fromEntries(
    roles.map((role) => [
      role,
      {
        stakeMicros: presets.alpha.minRoleStake,
        active: true,
        exitRequestedAt: null,
        openObligations: 0,
      },
    ]),
  ) as ProtocolAccount["roles"],
  credit: {} as ProtocolAccount["credit"],
});
export const market = (
  id: number,
  patch: Partial<ProtocolMarket> = {},
): ProtocolMarket => ({
  marketId: String(id),
  creator: address(0xc1),
  class: "A",
  state: "OPEN",
  templateId: hash(5),
  specHash: hash(100 + id),
  specUri: "https://blink.example/v1/content/" + hash(100 + id),
  replay: false,
  openAt: ORIGIN - 3600,
  closeAt: CLOSE_AT,
  proposalDeadline: CLOSE_AT + 100,
  hardDeadline: CLOSE_AT + 200,
  maxPairs: "1000",
  mintedPairs: "0",
  escrowMicros: "0",
  feePoolMicros: "0",
  finalOutcome: null,
  feesDistributed: false,
  creationChallenged: false,
  ...patch,
});
export const proposal = (
  marketId: number,
  proposedAt: number,
): ProtocolProposal => ({
  marketId: String(marketId),
  proposer: address(0xb1),
  outcome: "YES",
  bondMicros: "1000000",
  challengeEnd: proposedAt + 120,
  evidenceHash: hash(9),
  evidenceUri: "ipfs://evidence",
  proposedAt,
});

export const FORECASTERS = {
  a: testAccounts.maker,
  b: testAccounts.taker,
  c: testAccounts.proposer,
} as const;

export type Agent = Awaited<ReturnType<typeof inviteAgent>>;
type WindowRef = { marketId?: number; horizon?: 0 | 1; scheduledAt: number };

/**
 * PGlite with every migration, a pinned database clock, agents bound to wallets, the real forecast
 * service behind buildApi, a fake index and a fake signature check. The session runs as blink_api;
 * `asWorker` switches to blink_worker and `asOwner` to the schema owner for fixtures.
 */
export async function forecastFixture() {
  const t = await createTestDatabase();
  await t.db
    .exec(`CREATE OR REPLACE FUNCTION blink.now() RETURNS timestamptz LANGUAGE sql VOLATILE AS $$
    SELECT to_timestamp(${ORIGIN}) + make_interval(secs => COALESCE(NULLIF(current_setting('blink.test_clock_offset_seconds',true),''),'0')::double precision)
  $$`);
  const keyed = async (
    name: string,
    wallet: string,
    scopes = ["forecast:write"],
  ) => {
    const agent = await inviteAgent(t, { name, scopes });
    await bindWallet(t, agent.agentId, wallet);
    return agent;
  };
  const agents = {
    a: await keyed("a", FORECASTERS.a.address),
    b: await keyed("b", FORECASTERS.b.address),
    c: await keyed("c", FORECASTERS.c.address),
    wallet: await keyed("wallet", WALLET),
    outsider: await keyed("outsider", testAccounts.challenger.address),
    readOnly: await keyed("read-only", testAccounts.keeper.address, [
      "rfq:write",
    ]),
  };
  const reader = fakeProtocolReader({
    accounts: [
      roleHolder(FORECASTERS.a.address),
      roleHolder(FORECASTERS.b.address),
      roleHolder(FORECASTERS.c.address),
      roleHolder(WALLET),
      // Registered, but not a FORECASTER.
      roleHolder(testAccounts.challenger.address, ["TAKER"]),
      roleHolder(testAccounts.keeper.address),
    ],
    markets: [market(1)],
  });
  const verifier = fakeSignatureVerifier({
    contractWallets: { [WALLET]: testAccounts.trader.address },
  });
  // The signature check is the slow step: this runs while it is pending, as time and the index move on.
  const hooks: { whileVerifying?: (() => unknown) | undefined } = {};
  const slowVerifier = {
    ...verifier,
    verifyTypedData: async (
      args: Parameters<typeof verifier.verifyTypedData>[0],
    ) => {
      const result = await verifier.verifyTypedData(args);
      await hooks.whileVerifying?.();
      return result;
    },
  };
  const store = postgresForecastStore(t.pool, DEPLOYMENT);
  const app = buildApi({
    services: [
      createForecastService({
        store,
        identity: createIdentityService(
          postgresIdentityStore(t.pool),
          identityCrypto,
          "https://blink.example",
        ),
        reader,
        verifier: slowVerifier,
        deployment: { markets: MARKETS, anchor: ANCHOR },
      }),
    ],
  });
  app.log.level = "silent";
  let role: string | null = "blink_api";
  await t.setRole(role);
  const switchTo = async (next: string | null) => {
    role = next;
    await t.setRole(next);
  };

  const fixture = {
    t,
    agents,
    reader,
    verifier,
    hooks,
    app,
    store,
    /** Moves the database clock to ORIGIN + seconds. */
    clock: (seconds: number) =>
      t.db.exec(`SET blink.test_clock_offset_seconds='${seconds}'`),
    /** Runs `work` as the schema owner (fixtures), then restores the role. */
    async asOwner<T>(work: () => Promise<T>): Promise<T> {
      const before = role;
      await switchTo(null);
      try {
        return await work();
      } finally {
        await switchTo(before);
      }
    },
    async asWorker<T>(work: () => Promise<T>): Promise<T> {
      const before = role;
      await switchTo("blink_worker");
      try {
        return await work();
      } finally {
        await switchTo(before);
      }
    },
    scheduler: (schedule?: Parameters<typeof createWindowScheduler>[2]) =>
      createWindowScheduler(store, reader, schedule),
    /** A window of market `marketId` ending `deadlineIn` seconds after the origin, open for `openFor` seconds. */
    async addWindow(
      deadlineIn: number,
      options: { marketId?: number; horizon?: 0 | 1; openFor?: number } = {},
    ) {
      const id = randomUUID();
      await fixture.asOwner(() =>
        t.db.query(
          `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
           VALUES($1,$2,$3,$4,to_timestamp($5::bigint),to_timestamp($5::bigint-$6::bigint),to_timestamp($5::bigint))`,
          [
            id,
            DEPLOYMENT,
            options.marketId ?? 1,
            (options.horizon ?? 0) === 0 ? "DAILY" : "PRE_CLOSE",
            ORIGIN + deadlineIn,
            options.openFor ?? 1800,
          ],
        ),
      );
      return {
        id,
        marketId: options.marketId ?? 1,
        horizon: (options.horizon ?? 0) as 0 | 1,
        scheduledAt: ORIGIN + deadlineIn,
      };
    },
    message(
      who: { address: string },
      window: WindowRef,
      patch: Partial<ForecastMessage> = {},
    ): ForecastMessage {
      return {
        forecaster: who.address.toLowerCase(),
        markets: MARKETS,
        marketId: String(window.marketId ?? 1),
        horizon: window.horizon ?? 0,
        scheduledAt: window.scheduledAt,
        probabilityBps: 6000,
        contentHash: NO_CONTENT_HASH,
        ...patch,
      };
    },
    /** `signer` signs `message` exactly as given. */
    sign: (signer: LocalAccount, message: ForecastMessage, anchor = ANCHOR) =>
      signer.signTypedData(forecastTypedData({ anchor, message })),
    body(message: ForecastMessage, signature: string): Record<string, unknown> {
      return {
        horizon: message.horizon,
        scheduledAt: Number(message.scheduledAt),
        probabilityBps: message.probabilityBps,
        contentHash: message.contentHash,
        signature,
      };
    },
    /** `signer` signs an answer for `window` (as `options.as` when it is a contract wallet) and posts it. */
    async submit(
      agent: { apiKey: string },
      signer: LocalAccount,
      window: WindowRef,
      patch: Partial<ForecastMessage> = {},
      options: { as?: { address: string } } = {},
    ) {
      const message = fixture.message(options.as ?? signer, window, patch);
      return fixture.post(
        window.marketId ?? 1,
        agent,
        fixture.body(message, await fixture.sign(signer, message)),
      );
    },
    post: (
      marketId: number,
      agent: { apiKey: string } | null,
      payload: unknown,
    ) =>
      app.inject({
        method: "POST",
        url: `/v1/markets/${marketId}/forecasts`,
        headers: {
          "idempotency-key": randomUUID(),
          ...(agent ? { authorization: "Bearer " + agent.apiKey } : {}),
        },
        payload: payload as object,
      }),
    get: (url: string, agent?: { apiKey: string } | null) =>
      app.inject({
        method: "GET",
        url,
        headers: agent ? { authorization: "Bearer " + agent.apiKey } : {},
      }),
    /** Row counts that a refused request must leave unchanged. */
    async stored() {
      const q = async (sql: string) =>
        Number((await t.db.query<{ n: string }>(sql)).rows[0]!.n);
      return {
        submissions: await q(
          "SELECT count(*)::text AS n FROM forecasts.submissions",
        ),
        audits: await q(
          "SELECT count(*)::text AS n FROM operations.audit_log WHERE action='forecast.submitted'",
        ),
        annotations: await q(
          "SELECT count(*)::text AS n FROM forecasts.annotations",
        ),
      };
    },
    /** A signed-looking answer written directly, for suites that are not about admission. */
    async insertAnswer(
      windowId: string,
      who: { agent: Agent; address: string },
      probabilityBps: number,
    ) {
      const id = randomUUID();
      await fixture.asOwner(() =>
        t.db.query(
          `INSERT INTO forecasts.submissions(id,window_id,agent_id,operator_id,key_id,forecaster_address,digest,signature,
             content_hash,verified_block,probability_bps,received_at)
           VALUES($1,$2,$3,$4,$5,decode($6,'hex'),decode($7,'hex'),'0x00',decode($8,'hex'),1,$9,blink.now())`,
          [
            id,
            windowId,
            who.agent.agentId,
            who.agent.operatorId,
            who.agent.keyId,
            who.address.slice(2).toLowerCase(),
            randomBytes(32).toString("hex"),
            "00".repeat(32),
            probabilityBps,
          ],
        ),
      );
      return id;
    },
    close: async () => {
      await app.close();
      await t.close();
    },
  };
  return fixture;
}
export type ForecastFixture = Awaited<ReturnType<typeof forecastFixture>>;
