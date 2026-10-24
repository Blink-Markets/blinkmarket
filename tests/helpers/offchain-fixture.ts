import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApi } from "../../apps/api/src/server.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { fileObjectStore } from "../../packages/adapters/src/file-object-store.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import { postgresContentStore } from "../../packages/adapters/src/content-store.js";
import { postgresSuggestionStore } from "../../packages/adapters/src/suggestion-store.js";
import { createIdentityService } from "../../packages/application/src/identity.js";
import { createContentService } from "../../packages/application/src/content.js";
import { createSuggestionService } from "../../packages/application/src/suggestions.js";
import {
  presets,
  type ProtocolAccount,
  type ProtocolMarket,
} from "../../packages/schemas/src/index.js";
import { bindWallet, createTestDatabase, inviteAgent } from "./database.js";
import { fakeProtocolReader } from "./protocol-reader.js";

export const PUBLIC_ORIGIN = "https://blink.example";
export const addresses = {
  creator: "0x00000000000000000000000000000000000000c1",
  forecaster: "0x00000000000000000000000000000000000000f1",
  stranger: "0x00000000000000000000000000000000000000e1",
};

const account = (address: string, creator: boolean): ProtocolAccount => ({
  address,
  registered: true,
  roles: (creator
    ? {
        CREATOR: {
          stakeMicros: presets.baseSepolia.minRoleStake,
          active: true,
          exitRequestedAt: null,
          openObligations: 0,
        },
      }
    : {}) as ProtocolAccount["roles"],
  credit: {} as ProtocolAccount["credit"],
});

export const marketFor = (specHash: string): ProtocolMarket => ({
  marketId: "1",
  creator: addresses.creator,
  class: "B",
  state: "OPEN",
  templateId: "0x" + "1".repeat(64),
  specHash,
  specUri: "https://blink.example/v1/content/" + specHash,
  replay: false,
  openAt: 1,
  closeAt: 2,
  proposalDeadline: 3,
  hardDeadline: 4,
  maxPairs: "10",
  mintedPairs: "0",
  escrowMicros: "0",
  feePoolMicros: "0",
  finalOutcome: null,
  feesDistributed: false,
  creationChallenged: false,
});

/**
 * The content and suggestion routes over an in-process database and a temporary object directory.
 * `creator` is a registered CREATOR, `forecaster` is registered without a role, `stranger` has a
 * key and a bound wallet but is not registered, and `scopeless` has a registered wallet but no scope.
 */
export async function offchainFixture(
  options: Pick<
    Parameters<typeof buildApi>[0] & object,
    "suggestionLimits"
  > = {},
) {
  const t = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "blink-content-"));
  const scopes = ["content:write", "suggestion:claim"];
  const creator = await inviteAgent(t, { name: "creator", scopes });
  const forecaster = await inviteAgent(t, { name: "forecaster", scopes });
  const stranger = await inviteAgent(t, { name: "stranger", scopes });
  const scopeless = await inviteAgent(t, {
    name: "scopeless",
    scopes: ["forecast:write"],
  });
  await bindWallet(t, creator.agentId, addresses.creator);
  await bindWallet(t, forecaster.agentId, addresses.forecaster);
  await bindWallet(t, stranger.agentId, addresses.stranger);
  await bindWallet(
    t,
    scopeless.agentId,
    "0x00000000000000000000000000000000000000d1",
  );
  await t.setRole("blink_api");
  const reader = fakeProtocolReader({
    accounts: [
      account(addresses.creator, true),
      account(addresses.forecaster, false),
      account("0x00000000000000000000000000000000000000d1", true),
    ],
  });
  const identity = createIdentityService(
    postgresIdentityStore(t.pool),
    identityCrypto,
    PUBLIC_ORIGIN,
  );
  const suggestions = postgresSuggestionStore(t.pool);
  const app = buildApi({
    services: [
      createContentService({
        store: postgresContentStore(t.pool, fileObjectStore(directory)),
        identity,
        reader,
        publicOrigin: PUBLIC_ORIGIN,
      }),
      createSuggestionService({ store: suggestions, identity, reader }),
    ],
    ...options,
  });
  app.log.level = "silent";
  const bearer = (agent: { apiKey: string }) => ({
    authorization: "Bearer " + agent.apiKey,
  });
  return {
    t,
    app,
    reader,
    directory,
    suggestions,
    agents: { creator, forecaster, stranger, scopeless },
    bearer,
    upload: (
      agent: { apiKey: string } | null,
      payload: Uint8Array | string,
      contentType = "application/json",
    ) =>
      app.inject({
        method: "POST",
        url: "/v1/content",
        headers: {
          ...(agent ? bearer(agent) : {}),
          "content-type": contentType,
        },
        payload: Buffer.from(payload),
      }),
    async close() {
      await app.close();
      await t.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
