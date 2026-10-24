import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPublicClient,
  http,
  serializeErc6492Signature,
  serializeSignature,
  hexToBigInt,
  slice,
  type Address,
  type Hex,
} from "viem";
import { viemSignatureVerifier } from "../../packages/adapters/src/signature-verifier.ts";
import { SignatureCheckUnavailable } from "../../packages/ports/src/signature.ts";
import { privateKeyToAccount } from "viem/accounts";
import { startAnvil, type Anvil } from "../helpers/anvil.ts";
import {
  contractWalletArtifacts,
  counterfactualWallet,
  saltOf,
} from "../helpers/contract-wallet.ts";

const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const MESSAGE = "Blink wallet proof 0x1234";
const typed = (verifyingContract: Address) =>
  ({
    domain: {
      name: "Blink RFQ",
      version: "0.2",
      chainId: 84532,
      verifyingContract,
    },
    types: { Ping: [{ name: "n", type: "uint256" }] },
    primaryType: "Ping",
    message: { n: 7n },
  }) as const;

async function deploy(
  anvil: Anvil,
  kind: "wallet" | "factory",
  args: readonly unknown[] = [],
) {
  const { wallet, factory } = contractWalletArtifacts();
  const { abi, bytecode } = kind === "wallet" ? wallet : factory;
  const client = anvil.wallet(anvil.accounts.admin);
  const receipt = await anvil.publicClient.waitForTransactionReceipt({
    hash: await client.deployContract({ abi, bytecode, args }),
  });
  assert.equal(receipt.status, "success");
  return receipt.contractAddress as Address;
}

async function fixture() {
  const anvil = await startAnvil();
  const { maker: owner, taker: stranger } = anvil.accounts;
  const wallet = await deploy(anvil, "wallet", [owner.address]);
  const factory = await deploy(anvil, "factory");
  return {
    anvil,
    owner,
    stranger,
    wallet,
    factory,
    verifier: viemSignatureVerifier(anvil.publicClient),
  };
}

test("EOA personal_sign and typed data valid", async () => {
  const { anvil, owner, stranger, verifier } = await fixture();
  try {
    const signature = await owner.signMessage({ message: MESSAGE });
    const head = await anvil.publicClient.getBlockNumber();
    const ok = await verifier.verifyMessage({
      address: owner.address,
      message: MESSAGE,
      signature,
    });
    assert.equal(ok.valid, true);
    assert.equal(ok.blockNumber, head);
    assert.equal(
      (
        await verifier.verifyMessage({
          address: stranger.address,
          message: MESSAGE,
          signature,
        })
      ).valid,
      false,
    );
    assert.equal(
      (
        await verifier.verifyMessage({
          address: owner.address,
          message: "other",
          signature,
        })
      ).valid,
      false,
    );

    const data = typed(anvil.accounts.keeper.address);
    const typedSignature = await owner.signTypedData(data);
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: owner.address,
          typedData: data,
          signature: typedSignature,
        })
      ).valid,
      true,
    );
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: stranger.address,
          typedData: data,
          signature: typedSignature,
        })
      ).valid,
      false,
    );
    // Garbage is an invalid signature, not an outage.
    assert.equal(
      (
        await verifier.verifyMessage({
          address: owner.address,
          message: MESSAGE,
          signature: "0x1234",
        })
      ).valid,
      false,
    );
  } finally {
    await anvil.stop();
  }
});

test("EOA high-s signature rejected", async () => {
  const { anvil, owner, verifier } = await fixture();
  try {
    const signature = await owner.signMessage({ message: MESSAGE });
    const r = slice(signature, 0, 32);
    const s = hexToBigInt(slice(signature, 32, 64));
    const v = Number(hexToBigInt(slice(signature, 64, 65)));
    const flipped = serializeSignature({
      r,
      s: ("0x" + (SECP256K1_N - s).toString(16).padStart(64, "0")) as Hex,
      v: BigInt(v === 27 ? 28 : 27),
    });
    assert.equal(
      (
        await verifier.verifyMessage({
          address: owner.address,
          message: MESSAGE,
          signature,
        })
      ).valid,
      true,
    );
    assert.equal(
      (
        await verifier.verifyMessage({
          address: owner.address,
          message: MESSAGE,
          signature: flipped,
        })
      ).valid,
      false,
    );
    // v of 0/1 is not accepted either (OpenZeppelin tryRecover wants 27/28).
    const v01 = (signature.slice(0, -2) + (v === 27 ? "00" : "01")) as Hex;
    assert.equal(
      (
        await verifier.verifyMessage({
          address: owner.address,
          message: MESSAGE,
          signature: v01,
        })
      ).valid,
      false,
    );
  } finally {
    await anvil.stop();
  }
});

test("ERC-1271 wallet accepts its owner's typed data", async () => {
  const { anvil, owner, wallet, verifier } = await fixture();
  try {
    const data = typed(wallet);
    const signature = await owner.signTypedData(data);
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: wallet,
          typedData: data,
          signature,
        })
      ).valid,
      true,
    );
    const personal = await owner.signMessage({ message: MESSAGE });
    // personal_sign over a different hash than the wallet checks: still the owner's key.
    assert.equal(
      (
        await verifier.verifyMessage({
          address: wallet,
          message: MESSAGE,
          signature: personal,
        })
      ).valid,
      true,
    );
  } finally {
    await anvil.stop();
  }
});

test("ERC-1271 wallet rejects another key", async () => {
  const { anvil, stranger, wallet, verifier } = await fixture();
  try {
    const data = typed(wallet);
    const signature = await stranger.signTypedData(data);
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: wallet,
          typedData: data,
          signature,
        })
      ).valid,
      false,
    );
  } finally {
    await anvil.stop();
  }
});

test("ERC-6492 signature for an undeployed account valid", async () => {
  const { anvil, owner, stranger, factory, verifier } = await fixture();
  try {
    const counterfactual = counterfactualWallet(
      factory,
      owner.address,
      saltOf(1),
    );
    assert.equal(
      await anvil.publicClient.getCode({ address: counterfactual.address }),
      undefined,
    );
    const data = typed(counterfactual.address);
    const wrap = (inner: Hex) =>
      serializeErc6492Signature({
        address: factory,
        data: counterfactual.factoryData,
        signature: inner,
      });
    const good = wrap(await owner.signTypedData(data));
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: counterfactual.address,
          typedData: data,
          signature: good,
        })
      ).valid,
      true,
    );
    const bad = wrap(await stranger.signTypedData(data));
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: counterfactual.address,
          typedData: data,
          signature: bad,
        })
      ).valid,
      false,
    );
    // The check is a simulation: the account is still undeployed afterwards.
    assert.equal(
      await anvil.publicClient.getCode({ address: counterfactual.address }),
      undefined,
    );
    // A bare ECDSA signature for an address without code is not a valid wallet signature.
    const bare = await owner.signTypedData(data);
    assert.equal(
      (
        await verifier.verifyTypedData({
          address: counterfactual.address,
          typedData: data,
          signature: bare,
        })
      ).valid,
      false,
    );
  } finally {
    await anvil.stop();
  }
});

test("RPC failure throws SignatureCheckUnavailable", async () => {
  const dead = viemSignatureVerifier(
    createPublicClient({
      transport: http("http://127.0.0.1:1", { retryCount: 0, timeout: 2000 }),
    }),
  );
  // Anvil's public default key #0: a fixture, never funded on a live network.
  const owner = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const signature = await owner.signMessage({ message: MESSAGE });
  await assert.rejects(
    dead.verifyMessage({ address: owner.address, message: MESSAGE, signature }),
    SignatureCheckUnavailable,
  );
  await assert.rejects(
    dead.verifyTypedData({
      address: owner.address,
      typedData: typed(owner.address),
      signature,
    }),
    SignatureCheckUnavailable,
  );
});
