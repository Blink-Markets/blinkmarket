import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { viemSignatureVerifier } from "../../packages/adapters/src/signature-verifier.ts";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.ts";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.ts";
import { createIdentityService } from "../../packages/application/src/identity.ts";
import type { ProtocolAccount } from "../../packages/schemas/src/index.ts";
import { buildApi } from "../../apps/api/src/server.ts";
import { startAnvil } from "../helpers/anvil.ts";
import { contractWalletArtifacts } from "../helpers/contract-wallet.ts";
import { createTestDatabase } from "../helpers/database.ts";
import { fakeProtocolReader } from "../helpers/protocol-reader.ts";

// End to end: a real MockErc1271Wallet on Anvil proves itself through the public endpoints and
// viemSignatureVerifier. Only the registered-account read is faked.
test("contract wallet proof accepted through the verification endpoint on Anvil", async () => {
  const anvil = await startAnvil();
  const t = await createTestDatabase();
  try {
    const { maker: owner } = anvil.accounts;
    const stranger = anvil.accounts.taker;
    const { wallet } = contractWalletArtifacts();
    const deployer = anvil.wallet(anvil.accounts.admin);
    const receipt = await anvil.publicClient.waitForTransactionReceipt({
      hash: await deployer.deployContract({
        abi: wallet.abi,
        bytecode: wallet.bytecode,
        args: [owner.address],
      }),
    });
    assert.equal(receipt.status, "success");
    const walletAddress = receipt.contractAddress as Address;
    const registered = {
      address: walletAddress,
      registered: true,
      roles: {},
      credit: {},
    } as ProtocolAccount;
    await t.setRole("blink_api");
    const service = createIdentityService(
      postgresIdentityStore(t.pool),
      identityCrypto,
      "https://blink.example",
      {
        verifier: viemSignatureVerifier(anvil.publicClient),
        reader: fakeProtocolReader({ accounts: [registered] }),
      },
    );
    const api = buildApi({ identity: service });
    api.log.level = "silent";
    const post = (url: string, payload: object) =>
      api.inject({ method: "POST", url, payload });
    const prove = async (signer: typeof owner) => {
      const challenge = await post("/v1/auth/wallet-challenges", {
        address: walletAddress,
        action: "issue",
      });
      assert.equal(challenge.statusCode, 201, challenge.body);
      const { challengeId, message } = challenge.json();
      return post("/v1/auth/wallet-verifications", {
        challengeId,
        signature: await signer.signMessage({ message }),
      });
    };

    // Someone other than the wallet's owner cannot prove the wallet.
    const refused = await prove(stranger);
    assert.equal(refused.statusCode, 400, refused.body);
    assert.equal(refused.json().code, "INVALID_WALLET_SIGNATURE");
    assert.equal(
      (await t.db.query("SELECT 1 FROM identity.api_keys")).rows.length,
      0,
    );

    // The owner's signature is accepted by the wallet's isValidSignature (ERC-1271).
    const accepted = await prove(owner);
    assert.equal(accepted.statusCode, 200, accepted.body);
    const principal = await service.authenticate(
      "Bearer " + accepted.json().apiKey,
      "forecast:write",
    );
    assert.equal(principal.address, walletAddress.toLowerCase());
    await api.close();
  } finally {
    await t.close();
    await anvil.stop();
  }
});
