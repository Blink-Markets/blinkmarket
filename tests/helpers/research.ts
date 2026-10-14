import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { keccak256, toBytes } from "viem";
import type { Pool } from "pg";
import { buildApi } from "../../apps/api/src/server.js";
import { createBlinkClient } from "../../packages/client/src/index.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import { postgresPreparationStore } from "../../packages/adapters/src/preparation-store.js";
import { postgresForecastStore } from "../../packages/adapters/src/forecast-store.js";
import { postgresMarketReadStore } from "../../packages/adapters/src/market-read-store.js";
import { createSpecArchive } from "../../packages/adapters/src/spec-archive.js";
import { fixtureModelGateway } from "../../packages/adapters/src/fixture-model-gateway.js";
import { postgresBudgetLedger } from "../../packages/adapters/src/budget-ledger.js";
import {
  createIdentityService,
  authenticateIdentity,
} from "../../packages/application/src/identity.js";
import { createPreparationService } from "../../packages/application/src/preparation.js";
import { createForecastService } from "../../packages/application/src/forecasts.js";
import { createMarketReadService } from "../../packages/application/src/market-read.js";
import { createBudgetedModelCaller } from "../../packages/application/src/budgeted-model.js";
import type {
  ImmutableObjectStore,
  ModelGateway,
} from "../../packages/ports/src/index.js";
import type { ModelRate } from "../../packages/domain/src/costs.js";
import { createTestDatabase, inviteAgent } from "./database.js";
import type { TestDatabase } from "./database.js";

/** The client validates responses against the contract but types them as unknown. */
export async function candidateOf(
  client: { getCandidate(id: string): Promise<unknown> },
  id: string,
) {
  return (await client.getCandidate(id)) as {
    candidate: { evidenceIds: string[]; state: string };
  };
}

export const hashText = (text: string) => keccak256(toBytes(text));
export const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * A pool on the shared PGlite session that switches to `role` whenever a
 * connection is checked out, so the real API and the real worker stores can
 * take turns on one session with their own grants.
 */
export function poolAs(t: TestDatabase, role: string): Pool {
  const connect = async () => {
    const client = await (
      t.pool as unknown as {
        connect(): Promise<{
          query(sql: string, params?: unknown[]): Promise<unknown>;
          release(): void;
        }>;
      }
    ).connect();
    await client.query(`SET ROLE ${role}`);
    return client;
  };
  return {
    connect,
    async query(sql: string, params?: unknown[]) {
      const client = await connect();
      try {
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    },
  } as unknown as Pool;
}

/** Records every statement a pool runs, to prove what a component never touches. */
export function recordingPool(inner: Pool, statements: string[]): Pool {
  const wrap = (client: { query: Function; release: Function }) => ({
    query: (sql: string, params?: unknown[]) => {
      statements.push(sql);
      return client.query(sql, params);
    },
    release: () => client.release(),
  });
  return {
    async connect() {
      return wrap(await (inner as any).connect());
    },
    async query(sql: string, params?: unknown[]) {
      statements.push(sql);
      return (inner as any).query(sql, params);
    },
  } as unknown as Pool;
}

export const testRate: ModelRate = {
  inputUsdMicrosPerMillionTokens: 3_000_000n,
  outputUsdMicrosPerMillionTokens: 15_000_000n,
  perRequestUsdMicros: 1000n,
};

export function memoryObjects(): ImmutableObjectStore & {
  objects: Map<string, Uint8Array>;
} {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async putIfAbsent(bytes, contentHash) {
      objects.set("memory:" + contentHash, bytes.slice());
      return { uri: "memory:" + contentHash };
    },
    async read(uri) {
      const bytes = objects.get(uri);
      if (!bytes) throw new Error("MISSING_OBJECT");
      return bytes;
    },
  };
}

/**
 * The real API (identity, candidates, forecasts, market reads) over PGlite on a
 * loopback port, the real worker stores and ledger, and invited platform agents.
 */
export async function researchFixture() {
  const t = await createTestDatabase();
  const worker = poolAs(t, "blink_worker");
  const apiPool = poolAs(t, "blink_api");
  const objects = memoryObjects();
  const specObjects = memoryObjects();
  const identityStore = postgresIdentityStore(apiPool);
  const app = buildApi({
    identity: createIdentityService(
      identityStore,
      identityCrypto,
      "https://blink.example",
    ),
    preparation: createPreparationService(
      postgresPreparationStore(apiPool),
      identityCrypto,
    ),
    services: [
      createForecastService({
        store: postgresForecastStore(apiPool),
        crypto: identityCrypto,
      }),
      createMarketReadService({
        store: postgresMarketReadStore(apiPool),
        archive: createSpecArchive(specObjects),
        identity: {
          authenticate: (authorization) =>
            identityStore.run(async (tx) => {
              const principal = await authenticateIdentity(
                tx,
                identityCrypto,
                authorization,
              );
              return {
                ...principal,
                wallet: await tx.wallet(principal.agentId),
              };
            }),
        },
      }),
    ],
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const agents = {
    discovery: await inviteAgent(t, {
      name: "discovery",
      scopes: ["candidate:write"],
    }),
    FORECASTER_A: await inviteAgent(t, {
      name: "forecaster-a",
      scopes: ["forecast:write"],
    }),
    FORECASTER_B: await inviteAgent(t, {
      name: "forecaster-b",
      scopes: ["forecast:write"],
    }),
    BASELINE: await inviteAgent(t, {
      name: "baseline",
      scopes: ["forecast:write"],
    }),
  };
  const asOwner = async <T>(work: () => Promise<T>): Promise<T> => {
    await t.db.exec("RESET ROLE");
    return work();
  };
  const clients = Object.fromEntries(
    Object.entries(agents).map(([name, agent]) => [
      name,
      createBlinkClient(url, agent.apiKey),
    ]),
  ) as Record<keyof typeof agents, ReturnType<typeof createBlinkClient>>;

  const ledger = postgresBudgetLedger(worker);
  function modelCaller(
    respond: Parameters<typeof fixtureModelGateway>[0]["respond"],
    rates: Record<string, ModelRate> = {},
    wrap: (gateway: ModelGateway) => ModelGateway = (gateway) => gateway,
  ) {
    return createBudgetedModelCaller({
      ledger,
      gateway: wrap(
        fixtureModelGateway({
          rates: { "test-model": testRate, ...rates },
          respond,
        }),
      ),
    });
  }

  return {
    t,
    app,
    url,
    worker,
    objects,
    specObjects,
    agents,
    clients,
    ledger,
    modelCaller,
    asOwner,
    async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
      return asOwner(async () => (await t.db.query<R>(sql, params)).rows);
    },
    async addSource(entity = "ACME", fetchEnabled = true) {
      const id = randomUUID();
      await asOwner(() =>
        t.db.query(
          "INSERT INTO evidence.sources(id,entity_id,source_url,fetch_enabled) VALUES ($1,$2,$3,$4)",
          [id, entity, `https://ir.example.test/${id}`, fetchEnabled],
        ),
      );
      return id;
    },
    async addEvidence(input: {
      sourceId: string;
      operatorId: string;
      text: string;
      observedAt?: string;
      access?: "PUBLIC" | "PRIVATE";
    }) {
      const bytes = utf8(input.text);
      const contentHash = keccak256(bytes);
      const { uri } = await objects.putIfAbsent(bytes, contentHash);
      const evidenceId = randomUUID();
      await asOwner(() =>
        t.db.query(
          `INSERT INTO evidence.records(id,source_id,operator_id,content_hash,object_uri,observed_at,access_policy)
           VALUES ($1,$2,$3,decode($4,'hex'),$5,COALESCE($6::timestamptz,blink.now()),$7)`,
          [
            evidenceId,
            input.sourceId,
            input.operatorId,
            contentHash.slice(2),
            uri,
            input.observedAt ?? null,
            input.access ?? "PUBLIC",
          ],
        ),
      );
      return { evidenceId, contentHash, uri };
    },
    /** A REPLAY market whose spec cites `evidenceIds`, with an approval for `budgetMicros`. */
    async addMarket(input: {
      evidenceIds: string[];
      budgetMicros?: bigint;
      closeInSeconds?: number;
    }) {
      const spec = JSON.parse(
        await readFile(
          new URL("../../fixtures/replay/market-spec.json", import.meta.url),
          "utf8",
        ),
      );
      spec.sourceEvidenceIds = input.evidenceIds;
      const bytes = utf8(JSON.stringify(spec));
      const specHash = keccak256(bytes);
      specObjects.objects.set("memory:spec", bytes);
      const candidateId = randomUUID();
      const keyId = agents.discovery.keyId;
      await asOwner(async () => {
        await t.db.query(
          "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ('d1','{}',decode($1,'hex')) ON CONFLICT DO NOTHING",
          ["11".repeat(20)],
        );
        await t.db.query(
          `INSERT INTO chain.markets
           (deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
           VALUES ('d1',1,decode($1,'hex'),'memory:spec','REPLAY',floor(extract(epoch from blink.now()))+$2,9999999999,9999999999,120,100,100,'OPEN',1,decode(repeat('33',32),'hex'),decode(repeat('44',32),'hex'))`,
          [specHash.slice(2), input.closeInSeconds ?? 7200],
        );
        await t.db.query(
          "INSERT INTO markets.specs(hash,object_uri,public_uri) VALUES (decode($1,'hex'),'memory:spec','https://spec.invalid')",
          [specHash.slice(2)],
        );
        // The candidate's current-revision foreign key is deferred to commit.
        await t.db.exec("BEGIN");
        await t.db.query(
          "INSERT INTO discovery.candidates(id,operator_id,current_revision) VALUES ($1,$2,1)",
          [candidateId, agents.discovery.operatorId],
        );
        await t.db.query(
          "INSERT INTO discovery.candidate_revisions(candidate_id,revision,snapshot) VALUES ($1,1,$2)",
          [
            candidateId,
            {
              candidateId,
              revision: 1,
              state: "DEPLOY_PENDING",
              entityId: "ACME",
            },
          ],
        );
        await t.db.exec("COMMIT");
        await t.db.query(
          "INSERT INTO markets.approvals(id,candidate_id,revision,deployment_id,spec_hash,actor_key_id,budget_micros,reason) VALUES ($1,$2,1,'d1',decode($3,'hex'),$4,$5,'test')",
          [
            randomUUID(),
            candidateId,
            specHash.slice(2),
            keyId,
            String(input.budgetMicros ?? 2_000_000n),
          ],
        );
      });
      return { deploymentId: "d1", marketId: "1", specHash, candidateId };
    },
    /** Registers a platform agent; `promptHash` defaults to the hash of its real template. */
    async registerAgent(
      role: "FORECASTER_A" | "FORECASTER_B" | "BASELINE",
      model: string,
      promptHash: string,
    ) {
      await asOwner(() =>
        t.db.query(
          "INSERT INTO forecasts.platform_agents(agent_id,role,model,prompt_hash,policy_version) VALUES ($1,$2,$3,decode($4,'hex'),'v1')",
          [agents[role].agentId, role, model, promptHash.slice(2)],
        ),
      );
    },
    /** A window that closes `deadlineInSeconds` from now (it opened 30 minutes earlier). */
    async addWindow(deadlineInSeconds = 600) {
      const id = randomUUID();
      await asOwner(() =>
        t.db.query(
          `INSERT INTO forecasts.windows(id,deployment_id,market_id,horizon_type,scheduled_at,open_at,deadline)
           SELECT $1,'d1',1,'DAILY',d,d-interval '30 minutes',d FROM (SELECT date_trunc('second',blink.now())+make_interval(secs=>$2) AS d) x`,
          [id, deadlineInSeconds],
        ),
      );
      return id;
    },
    async close() {
      await app.close();
      await t.close();
    },
  };
}
export type ResearchFixture = Awaited<ReturnType<typeof researchFixture>>;
