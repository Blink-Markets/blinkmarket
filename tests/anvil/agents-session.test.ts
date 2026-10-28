import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createWalletClient, custom, type Address } from "viem";
import { agentAbi } from "../../packages/client/src/index.ts";
import { loadProtocolArtifacts } from "../../packages/adapters/src/protocol-deployer.ts";
import type { AgentContext } from "../../examples/agents/src/lib/env.ts";
import { send } from "../../examples/agents/src/lib/session.ts";
import { startAnvil } from "../helpers/anvil.ts";

test("send funds a faucet checkpoint append when estimation and mining cross a second", { timeout: 30_000 }, async () => {
  const anvil = await startAnvil();
  try {
    const { BlinkFaucet: faucet } = await loadProtocolArtifacts();
    const deployed = await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.wallet(anvil.accounts.admin).deployContract({ abi: faucet.abi, bytecode: faucet.bytecode }),
    });
    assert.equal(deployed.status, "success");
    const request = { address: deployed.contractAddress as Address, abi: agentAbi.faucet, functionName: "claim" } as const;
    // Start near a wall-clock second's beginning so the seed and estimate share its checkpoint.
    await delay(1000 - Date.now() % 1000 + 20);
    const seeded = await anvil.publicClient.waitForTransactionReceipt({
      hash: await anvil.wallet(anvil.accounts.maker).writeContract({ ...request, gas: 300_000n }),
    });
    assert.equal(seeded.status, "success");
    const account = anvil.accounts.taker;
    const estimate = await anvil.publicClient.estimateContractGas({ ...request, account });
    assert.ok(estimate < 145_631n, `expected the checkpoint-update estimate, got ${estimate}`);
    // Delay only the signed transaction's submission: viem's real gas estimation still runs.
    const walletClient = createWalletClient({ account, chain: anvil.publicClient.chain, transport: custom({
      async request(args) {
        if (args.method === "eth_sendRawTransaction") await delay(1200);
        return anvil.publicClient.request(args as never);
      },
    }) });
    const receipt = await send({ account, publicClient: anvil.publicClient, walletClient } as unknown as AgentContext, "FAUCET_CLAIM", request);
    const seedBlock = await anvil.publicClient.getBlock({ blockHash: seeded.blockHash });
    const claimBlock = await anvil.publicClient.getBlock({ blockHash: receipt.blockHash });
    assert.ok(claimBlock.timestamp > seedBlock.timestamp);
    assert.ok(receipt.gasUsed > estimate, "claim must exercise the more expensive checkpoint append");
    const tx = await anvil.publicClient.getTransaction({ hash: receipt.transactionHash });
    assert.ok(tx.gas > estimate);
    console.log(`faucet boundary: estimate=${estimate} gasLimit=${tx.gas} gasUsed=${receipt.gasUsed} seedTime=${seedBlock.timestamp} claimTime=${claimBlock.timestamp}`);
  } finally {
    await anvil.stop();
  }
});
