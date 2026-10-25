import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, hashTypedData, type Hex } from "viem";
import { buildApi } from "../apps/api/src/server.js";
import { identityCrypto } from "../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../packages/adapters/src/identity-store.js";
import { postgresRfqStore } from "../packages/adapters/src/rfq-store.js";
import { createIdentityService } from "../packages/application/src/identity.js";
import { createRfqService } from "../packages/application/src/rfq-relay.js";
import {
  apiContracts,
  presets,
  quoteTypes,
  type ProtocolAccount,
  type ProtocolMarket,
  type RoleName,
} from "../packages/schemas/src/index.js";
import { bindWallet, createTestDatabase, inviteAgent } from "./helpers/database.js";
import { fakeProtocolReader } from "./helpers/protocol-reader.js";
import { testAccounts } from "./helpers/protocol-fixture.js";
import { hash, seedProtocolDeployment } from "./helpers/protocol-index.js";
import { fakeSignatureVerifier } from "./helpers/signature-verifier.js";

const NOW = 1_000_000;
const CLOSE_AT = NOW + 600;
const MARKETS = "0x" + "11".repeat(20);
const SPEC_HASH = hash(77);
const WALLET_MAKER = "0x00000000000000000000000000000000000c0de1";
const E6 = 1_000_000n;
const ERC6492_MAGIC = "6492".repeat(16);

const roleHolder = (address: string, roles: RoleName[]): ProtocolAccount => ({
  address: address.toLowerCase(),
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
const market = (patch: Partial<ProtocolMarket> = {}): ProtocolMarket => ({
  marketId: "1",
  creator: "0x" + "c1".repeat(20),
  class: "A",
  state: "OPEN",
  templateId: hash(5),
  specHash: SPEC_HASH,
  specUri: "https://blink.example/v1/content/" + SPEC_HASH,
  replay: false,
  openAt: NOW - 100,
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

async function fixture() {
  const t = await createTestDatabase();
  const { taker, taker2, maker, proposer, trader } = testAccounts;
  const keyed = async (name: string, address: string, scopes = ["rfq:write"]) => {
    const agent = await inviteAgent(t, { name, scopes });
    await bindWallet(t, agent.agentId, address);
    return agent;
  };
  await seedProtocolDeployment(t.pool, "d1");
  const agents = {
    taker: await keyed("taker", taker.address),
    taker2: await keyed("taker2", taker2.address),
    maker: await keyed("maker", maker.address),
    maker2: await keyed("maker2", proposer.address),
    wallet: await keyed("wallet", WALLET_MAKER),
    // Holds both roles but only a forecast key.
    scopeless: await keyed("scopeless", "0x" + "dd".repeat(20), ["forecast:write"]),
  };
  await t.setRole("blink_api");
  const reader = fakeProtocolReader({
    accounts: [
      roleHolder(taker.address, ["TAKER"]),
      roleHolder(taker2.address, ["TAKER"]),
      roleHolder(maker.address, ["MAKER"]),
      roleHolder(proposer.address, ["MAKER"]),
      roleHolder(WALLET_MAKER, ["MAKER"]),
      roleHolder("0x" + "dd".repeat(20), ["TAKER", "MAKER"]),
    ],
    markets: [market()],
    makers: [maker.address, proposer.address, WALLET_MAKER].map((address) => ({
      address: address.toLowerCase(),
      freeMicros: "100000000",
      epoch: "0",
    })),
  });
  const verifier = fakeSignatureVerifier({
    contractWallets: { [WALLET_MAKER]: trader.address },
  });
  let clock = NOW;
  const app = buildApi({
    services: [
      createRfqService({
        store: postgresRfqStore(t.pool, "d1"),
        identity: createIdentityService(
          postgresIdentityStore(t.pool),
          identityCrypto,
          "https://blink.example",
        ),
        reader,
        verifier,
        deployment: { markets: MARKETS, maxFillShares: 100 },
        now: () => clock,
      }),
    ],
  });
  app.log.level = "silent";
  const as = (agent: { apiKey: string }) => ({
    authorization: "Bearer " + agent.apiKey,
  });
  const call = (
    method: "GET" | "POST",
    url: string,
    agent: { apiKey: string } | null,
    payload?: unknown,
  ) =>
    app.inject({
      method,
      url,
      headers: agent ? as(agent) : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const rfqBody = { marketId: "1", side: "YES", quantity: "10" };
  const openRfq = async (body: object = rfqBody, agent = agents.taker) => {
    const res = await call("POST", "/v1/rfqs", agent, body);
    assert.equal(res.statusCode, 201, res.body);
    return res.json() as { rfqId: string; expiresAt: number };
  };
  const quoteFields = (
    maker: string,
    patch: Record<string, string> = {},
    taker = testAccounts.taker.address,
  ) => ({
    marketId: "1",
    specHash: SPEC_HASH,
    maker,
    taker,
    side: "0",
    quantity: "10",
    priceBps: "6000",
    validAfter: String(clock),
    expiresAt: String(clock + 30),
    nonce: "1",
    epoch: "0",
    ...patch,
  });
  const messageOf = (q: ReturnType<typeof quoteFields>) => ({
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
  const domain = (version = "0.2") => ({
    name: "Blink RFQ",
    version,
    chainId: 84532,
    verifyingContract: MARKETS as Hex,
  });
  const digestOf = (q: ReturnType<typeof quoteFields>) =>
    hashTypedData({
      domain: domain(),
      types: quoteTypes,
      primaryType: "Quote",
      message: messageOf(q),
    });
  const sign = (
    signer: { signTypedData: (a: never) => Promise<Hex> },
    q: ReturnType<typeof quoteFields>,
  ) =>
    signer.signTypedData({
      domain: domain(),
      types: quoteTypes,
      primaryType: "Quote",
      message: messageOf(q),
    } as never);
  const post = async (
    rfqId: string,
    agent: { apiKey: string },
    q: ReturnType<typeof quoteFields>,
    signer: { signTypedData: (a: never) => Promise<Hex> },
  ) =>
    call("POST", `/v1/rfqs/${rfqId}/quotes`, agent, {
      quote: q,
      signature: await sign(signer, q),
    });
  const stored = async () => ({
    rfqs: (await t.db.query("SELECT count(*)::int AS n FROM rfq.requests")).rows[0] as { n: number },
    quotes: (await t.db.query("SELECT count(*)::int AS n FROM rfq.quotes")).rows[0] as { n: number },
  });
  return {
    t,
    app,
    reader,
    verifier,
    agents,
    call,
    openRfq,
    quoteFields,
    digestOf,
    sign,
    post,
    stored,
    setClock: (seconds: number) => {
      clock = seconds;
    },
    async close() {
      await app.close();
      await t.close();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const { maker, taker, taker2, proposer, trader } = testAccounts;
const contract = (method: string, path: string) =>
  apiContracts.find((c) => c.method === method && c.path === path)!;
const nothingStored = async (f: Fixture, rfqs = 1, quotes = 0) => {
  const s = await f.stored();
  assert.deepEqual([s.rfqs.n, s.quotes.n], [rfqs, quotes]);
};

test("rfq refuses non-OPEN market", async () => {
  const f = await fixture();
  try {
    for (const patch of [
      { state: "PENDING" },
      { state: "PROPOSED" },
      { state: "CANCELLED" },
      { closeAt: NOW }, // closed: now < closeAt no longer holds
    ] as const) {
      f.reader.set({ markets: [market(patch)] });
      const res = await f.call("POST", "/v1/rfqs", f.agents.taker, {
        marketId: "1",
        side: "YES",
        quantity: "10",
      });
      assert.equal(res.statusCode, 409, JSON.stringify(patch));
      assert.equal(res.json().code, "MARKET_NOT_TRADABLE");
    }
    f.reader.set({ markets: [] });
    const missing = await f.call("POST", "/v1/rfqs", f.agents.taker, rfqBody());
    assert.equal(missing.statusCode, 404);
    await nothingStored(f, 0);
    f.reader.set({ markets: [market()] });
    const ok = await f.call("POST", "/v1/rfqs", f.agents.taker, rfqBody());
    assert.equal(ok.statusCode, 201, ok.body);
    contract("POST", "/v1/rfqs").response.parse(ok.json());
    assert.equal(ok.json().expiresAt, NOW + 30);
  } finally {
    await f.close();
  }
});
const rfqBody = () => ({ marketId: "1", side: "YES", quantity: "10" });

test("rfq enforces scope, role and quantity", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call("POST", "/v1/rfqs", null, rfqBody())).statusCode, 401);
    const noScope = await f.call("POST", "/v1/rfqs", f.agents.scopeless, rfqBody());
    assert.deepEqual([noScope.statusCode, noScope.json().code], [403, "SCOPE_DENIED"]);
    // A maker without the TAKER role cannot request.
    const wrongRole = await f.call("POST", "/v1/rfqs", f.agents.maker, rfqBody());
    assert.deepEqual([wrongRole.statusCode, wrongRole.json().code], [403, "ROLE_REQUIRED"]);
    for (const quantity of ["0", "101", "-1", "1.5"]) {
      const res = await f.call("POST", "/v1/rfqs", f.agents.taker, { ...rfqBody(), quantity });
      assert.equal(res.statusCode, 400, quantity);
    }
    assert.equal(
      (await f.call("POST", "/v1/rfqs", f.agents.taker, { ...rfqBody(), quantity: "100" })).statusCode,
      201,
    );
    // Makers see RFQs; takers do not.
    assert.equal((await f.call("GET", "/v1/rfqs", f.agents.taker)).json().code, "ROLE_REQUIRED");
    const listed = await f.call("GET", "/v1/rfqs", f.agents.maker);
    assert.equal(listed.statusCode, 200, listed.body);
    contract("GET", "/v1/rfqs").response.parse(listed.json());
    assert.equal(listed.json().items[0].taker, taker.address.toLowerCase());
    assert.equal(listed.json().items[0].specHash, SPEC_HASH);
  } finally {
    await f.close();
  }
});

test("a taker holds at most five open rfqs, and an rfq closes after 30 seconds", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) await f.openRfq();
    const sixth = await f.call("POST", "/v1/rfqs", f.agents.taker, rfqBody());
    assert.deepEqual([sixth.statusCode, sixth.json().code], [409, "RFQ_LIMIT_REACHED"]);
    await nothingStored(f, 5);
    // Another taker is unaffected.
    await f.openRfq(rfqBody(), f.agents.taker2);
    // The open list pages, oldest first.
    const page = await f.call("GET", "/v1/rfqs?limit=4", f.agents.maker);
    assert.equal(page.json().items.length, 4);
    assert.ok(page.json().next);
    const rest = await f.call("GET", `/v1/rfqs?limit=4&after=${page.json().next}`, f.agents.maker);
    assert.equal(rest.json().items.length, 2);
    assert.equal(rest.json().next, null);
    // After 30 seconds they are closed and no longer listed or counted.
    f.setClock(NOW + 30);
    assert.equal((await f.call("GET", "/v1/rfqs", f.agents.maker)).json().items.length, 0);
    assert.equal((await f.call("POST", "/v1/rfqs", f.agents.taker, rfqBody())).statusCode, 201);
  } finally {
    await f.close();
  }
});

test("a valid quote is accepted and stored for the rfq", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const q = f.quoteFields(maker.address);
    const res = await f.post(rfqId, f.agents.maker, q, maker);
    assert.equal(res.statusCode, 201, res.body);
    contract("POST", "/v1/rfqs/:id/quotes").response.parse(res.json());
    assert.equal(res.json().digest, f.digestOf(q));
    // A closed RFQ takes no quote; an unknown one is not found.
    f.setClock(NOW + 30);
    const late = await f.post(rfqId, f.agents.maker2, f.quoteFields(proposer.address), proposer);
    assert.deepEqual([late.statusCode, late.json().code], [409, "RFQ_CLOSED"]);
    const unknown = await f.post(crypto.randomUUID(), f.agents.maker, q, maker);
    assert.equal(unknown.statusCode, 404);
  } finally {
    await f.close();
  }
});

test("quote with modified field rejected", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    // Terms that differ from the RFQ: refused whatever the signature says.
    const other = "0x" + "ee".repeat(20);
    const changes: [string, Record<string, string>][] = [
      ["taker", { taker: taker2.address }],
      ["marketId", { marketId: "2" }],
      ["side", { side: "1" }],
      ["quantity", { quantity: "9" }],
      ["specHash", { specHash: hash(78) }],
    ];
    for (const [field, patch] of changes) {
      const q = f.quoteFields(maker.address, patch);
      const res = await f.post(rfqId, f.agents.maker, q, maker);
      assert.equal(res.statusCode, 400, field);
      assert.equal(res.json().code, "QUOTE_MISMATCH", field);
      assert.equal(res.json().details.field, field);
    }
    // A quote that names someone else as maker is not the caller's.
    const named = f.quoteFields(other);
    const stolen = await f.post(rfqId, f.agents.maker, named, maker);
    assert.deepEqual([stolen.statusCode, stolen.json().code], [403, "MAKER_MISMATCH"]);
    // A field changed after signing breaks the signature.
    const q = f.quoteFields(maker.address);
    const signature = await f.sign(maker, q);
    const tampered = await f.call("POST", `/v1/rfqs/${rfqId}/quotes`, f.agents.maker, {
      quote: { ...q, priceBps: "1" },
      signature,
    });
    assert.deepEqual([tampered.statusCode, tampered.json().code], [400, "INVALID_QUOTE_SIGNATURE"]);
    // Unknown fields and a signature of the wrong shape are not quotes.
    for (const bad of [
      { quote: { ...q, extra: "1" }, signature },
      { quote: q, signature: "0x" + "g".repeat(130) },
      { quote: { ...q, side: "2" }, signature },
      { quote: q },
    ])
      assert.equal(
        (await f.call("POST", `/v1/rfqs/${rfqId}/quotes`, f.agents.maker, bad)).statusCode,
        400,
      );
    await nothingStored(f);
  } finally {
    await f.close();
  }
});

test("quote signed by another maker rejected", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const q = f.quoteFields(maker.address);
    // The right fields, signed by a key that is not the maker's.
    const res = await f.post(rfqId, f.agents.maker, q, proposer);
    assert.deepEqual([res.statusCode, res.json().code], [400, "INVALID_QUOTE_SIGNATURE"]);
    // Signed under the retired 0.1 domain.
    const old = await maker.signTypedData({
      domain: { name: "Blink RFQ", version: "0.1", chainId: 84532, verifyingContract: MARKETS as Hex },
      types: quoteTypes,
      primaryType: "Quote",
      message: {
        marketId: 1n, specHash: SPEC_HASH as Hex, maker: maker.address, taker: taker.address, side: 0,
        quantity: 10n, priceBps: 6000, validAfter: BigInt(NOW), expiresAt: BigInt(NOW + 30), nonce: 1n, epoch: 0n,
      },
    });
    const retired = await f.call("POST", `/v1/rfqs/${rfqId}/quotes`, f.agents.maker, { quote: q, signature: old });
    assert.equal(retired.json().code, "INVALID_QUOTE_SIGNATURE");
    // The taker has no MAKER role, so it cannot post at all.
    const asTaker = await f.post(rfqId, f.agents.taker, f.quoteFields(taker.address), taker);
    assert.deepEqual([asTaker.statusCode, asTaker.json().code], [403, "ROLE_REQUIRED"]);
    const noScope = await f.post(rfqId, f.agents.scopeless, f.quoteFields("0x" + "dd".repeat(20)), maker);
    assert.equal(noScope.json().code, "SCOPE_DENIED");
    await nothingStored(f);
  } finally {
    await f.close();
  }
});

test("contract wallet maker quote accepted", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const q = f.quoteFields(WALLET_MAKER);
    // The wallet's owner signs for the wallet (ERC-1271 in the fake).
    const accepted = await f.post(rfqId, f.agents.wallet, q, trader);
    assert.equal(accepted.statusCode, 201, accepted.body);
    // Anyone else's signature for the wallet is refused, exactly as BlinkMarkets would.
    const second = await f.openRfq();
    const refused = await f.post(second.rfqId, f.agents.wallet, f.quoteFields(WALLET_MAKER, { nonce: "2" }), maker);
    assert.deepEqual([refused.statusCode, refused.json().code], [400, "INVALID_QUOTE_SIGNATURE"]);
    // An ERC-6492 wrapped signature is not something BlinkMarkets accepts, so the relay refuses it.
    const wrapped = (await f.sign(trader, f.quoteFields(WALLET_MAKER, { nonce: "3" }))) + ERC6492_MAGIC;
    const res6492 = await f.call("POST", `/v1/rfqs/${second.rfqId}/quotes`, f.agents.wallet, {
      quote: f.quoteFields(WALLET_MAKER, { nonce: "3" }),
      signature: wrapped,
    });
    assert.deepEqual([res6492.statusCode, res6492.json().code], [400, "INVALID_QUOTE_SIGNATURE"]);
    await nothingStored(f, 2, 1);
  } finally {
    await f.close();
  }
});

test("signature check outage fails closed", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const q = f.quoteFields(maker.address);
    f.verifier.setUnavailable(true);
    const res = await f.post(rfqId, f.agents.maker, q, maker);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, "SIGNATURE_CHECK_UNAVAILABLE");
    assert.equal(res.json().retryable, true);
    await nothingStored(f);
    f.verifier.setUnavailable(false);
    assert.equal((await f.post(rfqId, f.agents.maker, q, maker)).statusCode, 201);
  } finally {
    await f.close();
  }
});

test("stale epoch rejected", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    f.reader.set({
      makers: [{ address: maker.address.toLowerCase(), freeMicros: "100000000", epoch: "2" }],
    });
    const stale = await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address, { epoch: "1" }), maker);
    assert.deepEqual([stale.statusCode, stale.json().code], [409, "STALE_EPOCH"]);
    await nothingStored(f);
    const current = await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address, { epoch: "2" }), maker);
    assert.equal(current.statusCode, 201, current.body);
  } finally {
    await f.close();
  }
});

test("a consumed or cancelled digest is refused", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const q = f.quoteFields(maker.address);
    for (const [status, code] of [
      ["CONSUMED", "QUOTE_CONSUMED"],
      ["CANCELLED", "QUOTE_CANCELLED"],
    ] as const) {
      f.reader.set({ digests: { [f.digestOf(q)]: status } });
      const res = await f.post(rfqId, f.agents.maker, q, maker);
      assert.deepEqual([res.statusCode, res.json().code], [409, code]);
    }
    await nothingStored(f);
  } finally {
    await f.close();
  }
});

test("insufficient maker free balance rejected", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    // 10 shares at 6000 bps: the maker covers 10 x 1e6 - 6e6 = 4e6.
    const need = 10n * E6 - 10n * 6000n * 100n;
    const free = (micros: bigint) =>
      f.reader.set({
        makers: [{ address: maker.address.toLowerCase(), freeMicros: micros.toString(), epoch: "0" }],
      });
    free(need - 1n);
    const short = await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address), maker);
    assert.deepEqual([short.statusCode, short.json().code], [409, "INSUFFICIENT_MAKER_BALANCE"]);
    await nothingStored(f);
    free(need);
    assert.equal((await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address), maker)).statusCode, 201);
  } finally {
    await f.close();
  }
});

test("lifetime over 60s rejected", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const refused = async (patch: Record<string, string>, reason: string) => {
      const res = await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address, patch), maker);
      assert.deepEqual([res.statusCode, res.json().code], [400, "INVALID_QUOTE_TERMS"], reason);
      assert.equal(res.json().details.reason, reason);
    };
    await refused({ validAfter: String(NOW), expiresAt: String(NOW + 61) }, "LIFETIME");
    await refused({ validAfter: String(NOW + 30), expiresAt: String(NOW + 30) }, "LIFETIME");
    await refused({ validAfter: String(NOW - 60), expiresAt: String(NOW) }, "EXPIRED");
    await refused({ validAfter: String(CLOSE_AT - 50), expiresAt: String(CLOSE_AT + 1) }, "AFTER_CLOSE");
    await refused({ priceBps: "0" }, "PRICE");
    await refused({ priceBps: "10000" }, "PRICE");
    await nothingStored(f);
    // Exactly 60 seconds is the longest a quote may live.
    const sixty = f.quoteFields(maker.address, { validAfter: String(NOW), expiresAt: String(NOW + 60) });
    assert.equal((await f.post(rfqId, f.agents.maker, sixty, maker)).statusCode, 201);
  } finally {
    await f.close();
  }
});

test("relay refuses when index is stale", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const q = f.quoteFields(maker.address);
    const signature = await f.sign(maker, q);
    f.reader.set({ health: { headBlock: 100, indexedBlock: 10, lagSeconds: 31, stale: true } });
    const writes = [
      await f.call("POST", "/v1/rfqs", f.agents.taker, rfqBody()),
      await f.call("POST", `/v1/rfqs/${rfqId}/quotes`, f.agents.maker, { quote: q, signature }),
      await f.call("GET", "/v1/rfqs", f.agents.maker),
    ];
    for (const res of writes) {
      assert.deepEqual([res.statusCode, res.json().code], [503, "INDEX_STALE"]);
      assert.equal(res.json().retryable, true);
    }
    await nothingStored(f);
    f.reader.set({ health: { headBlock: 100, indexedBlock: 100, lagSeconds: 0, stale: false } });
    assert.equal(
      (await f.call("POST", `/v1/rfqs/${rfqId}/quotes`, f.agents.maker, { quote: q, signature })).statusCode,
      201,
    );
  } finally {
    await f.close();
  }
});

test("quotes returned byte-identical", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    // Mixed-case addresses and an upper-case signature are kept as the maker sent them.
    const q = f.quoteFields(getAddress(maker.address), {}, getAddress(taker.address));
    const signature = ("0x" + (await f.sign(maker, q)).slice(2).toUpperCase()) as Hex;
    const body = { quote: q, signature };
    assert.equal((await f.call("POST", `/v1/rfqs/${rfqId}/quotes`, f.agents.maker, body)).statusCode, 201);
    const got = await f.call("GET", `/v1/rfqs/${rfqId}/quotes`, f.agents.taker);
    assert.equal(got.statusCode, 200, got.body);
    contract("GET", "/v1/rfqs/:id/quotes").response.parse(got.json());
    assert.equal(JSON.stringify(got.json().items[0]), JSON.stringify(body));
    assert.equal(got.json().items[0].signature, signature);
  } finally {
    await f.close();
  }
});

test("quotes are ordered by price, then arrival", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    const prices: [typeof maker, { apiKey: string }, string][] = [
      [maker, f.agents.maker, "6000"],
      [proposer, f.agents.maker2, "5500"],
      [trader, f.agents.wallet, "5500"],
    ];
    // The wallet maker signs through its owner; the fake treats the wallet address as the maker.
    for (const [signer, agent, priceBps] of prices) {
      const address = agent === f.agents.wallet ? WALLET_MAKER : signer.address;
      assert.equal(
        (await f.post(rfqId, agent, f.quoteFields(address, { priceBps }), signer)).statusCode,
        201,
      );
    }
    const got = (await f.call("GET", `/v1/rfqs/${rfqId}/quotes`, f.agents.taker)).json();
    assert.deepEqual(
      got.items.map((i: { quote: { priceBps: string; maker: string } }) => [i.quote.priceBps, i.quote.maker]),
      [
        ["5500", proposer.address],
        ["5500", WALLET_MAKER],
        ["6000", maker.address],
      ],
    );
  } finally {
    await f.close();
  }
});

test("only the taker reads quotes", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address), maker);
    for (const agent of [f.agents.taker2, f.agents.maker]) {
      const res = await f.call("GET", `/v1/rfqs/${rfqId}/quotes`, agent);
      assert.deepEqual([res.statusCode, res.json().code], [404, "NOT_FOUND"]);
    }
    assert.equal((await f.call("GET", `/v1/rfqs/${rfqId}/quotes`, null)).statusCode, 401);
    assert.equal((await f.call("GET", `/v1/rfqs/${rfqId}/quotes`, f.agents.scopeless)).json().code, "SCOPE_DENIED");
    assert.equal((await f.call("GET", `/v1/rfqs/${rfqId}/quotes`, f.agents.taker)).json().items.length, 1);
  } finally {
    await f.close();
  }
});

test("one quote per maker per rfq", async () => {
  const f = await fixture();
  try {
    const { rfqId } = await f.openRfq();
    assert.equal((await f.post(rfqId, f.agents.maker, f.quoteFields(maker.address), maker)).statusCode, 201);
    // A second, different quote from the same maker is refused, however good.
    const again = await f.post(
      rfqId,
      f.agents.maker,
      f.quoteFields(maker.address, { nonce: "2", priceBps: "5000" }),
      maker,
    );
    assert.deepEqual([again.statusCode, again.json().code], [409, "QUOTE_ALREADY_POSTED"]);
    await nothingStored(f, 1, 1);
    // The 21st maker finds the RFQ full: 19 more makers fill it, then one is turned away.
    const crowd = await fixture();
    try {
      const rfq = await crowd.openRfq();
      for (let i = 0; i < 20; i++) {
        // Rows are what the relay would write after its checks; the cap is the store's own.
        await crowd.t.db.query("RESET ROLE");
        await crowd.t.db.query(
          `INSERT INTO rfq.quotes(rfq_id,deployment_id,maker,digest,price_bps,expires_at,quote,signature,received_at)
           VALUES ($1,'d1',decode($2,'hex'),decode($3,'hex'),5000,${NOW + 30},'{}','0x1234',${NOW})`,
          [rfq.rfqId, (i + 100).toString(16).padStart(40, "0"), (i + 1).toString(16).padStart(64, "0")],
        );
        await crowd.t.setRole("blink_api");
      }
      const full = await crowd.post(rfq.rfqId, crowd.agents.maker, crowd.quoteFields(maker.address), maker);
      assert.deepEqual([full.statusCode, full.json().code], [409, "RFQ_FULL"]);
      assert.equal((await crowd.stored()).quotes.n, 20);
    } finally {
      await crowd.close();
    }
  } finally {
    await f.close();
  }
});

test("maker stats count fills and early cancels", async () => {
  const f = await fixture();
  try {
    const digests: string[] = [];
    for (let nonce = 1; nonce <= 4; nonce++) {
      const { rfqId } = await f.openRfq();
      const q = f.quoteFields(maker.address, { nonce: String(nonce) });
      const res = await f.post(rfqId, f.agents.maker, q, maker);
      assert.equal(res.statusCode, 201, res.body);
      digests.push(res.json().digest);
    }
    // Quotes by another maker never count for this one.
    const other = await f.openRfq(rfqBody(), f.agents.taker2);
    await f.post(
      other.rfqId,
      f.agents.maker2,
      f.quoteFields(proposer.address, { nonce: "9" }, taker2.address),
      proposer,
    );
    const empty = await f.call("GET", `/v1/makers/${maker.address}/stats`, null);
    assert.equal(empty.statusCode, 200, empty.body);
    contract("GET", "/v1/makers/:address/stats").response.parse(empty.json());
    assert.deepEqual(empty.json(), { quotesRelayed: 4, quotesFilled: 0, quotesCancelledBeforeExpiry: 0 });

    // Chain facts, written as the indexer would: digest 0 filled, 1 cancelled before it expired,
    // 2 cancelled after it expired, 3 untouched. A non-canonical fill (reorged out) does not count.
    await f.t.db.query("RESET ROLE");
    const block = async (n: number, timestamp: number, canonical = true) => {
      await f.t.db.query(
        `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
         VALUES ('d1',$1,decode($2,'hex'),decode($3,'hex'),$4,$5)`,
        [n, hash(1000 + n).slice(2), hash(999 + n).slice(2), timestamp, canonical],
      );
    };
    const event = async (n: number, name: string, digest: string, canonical = true) => {
      await f.t.db.query(
        `INSERT INTO protocol.events(deployment_id,block_hash,block_number,tx_hash,tx_index,log_index,emitter,contract,name,args,canonical)
         VALUES ('d1',decode($1,'hex'),$2,decode($3,'hex'),0,0,decode($4,'hex'),'MARKETS',$5,$6,$7)`,
        [hash(1000 + n).slice(2), n, hash(2000 + n).slice(2), MARKETS.slice(2), name, { digest }, canonical],
      );
    };
    await block(1, NOW + 5);
    await event(1, "QuoteFilled", digests[0]!);
    await block(2, NOW + 10);
    await event(2, "QuoteCancelled", digests[1]!);
    await block(3, NOW + 31); // expiresAt is NOW + 30: too late to count
    await event(3, "QuoteCancelled", digests[2]!);
    await block(4, NOW + 6, false);
    await event(4, "QuoteFilled", digests[3]!, false);
    await f.t.setRole("blink_api");
    const counted = await f.call("GET", `/v1/makers/${maker.address}/stats`, null);
    assert.deepEqual(counted.json(), { quotesRelayed: 4, quotesFilled: 1, quotesCancelledBeforeExpiry: 1 });
    const none = await f.call("GET", `/v1/makers/0x${"ab".repeat(20)}/stats`, null);
    assert.deepEqual(none.json(), { quotesRelayed: 0, quotesFilled: 0, quotesCancelledBeforeExpiry: 0 });
  } finally {
    await f.close();
  }
});
