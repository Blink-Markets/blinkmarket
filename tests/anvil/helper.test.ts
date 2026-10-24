import { test } from "node:test";
import assert from "node:assert/strict";
import { ProtocolDeployment } from "../../packages/schemas/src/index.js";
import { deployAlphaProtocol, startAnvil } from "../helpers/anvil.js";

test("startAnvil and deployAlphaProtocol give a valid manifest, working snapshots and a clean stop", async () => {
  const anvil = await startAnvil();
  try {
    assert.equal(anvil.chainId, 84532);
    assert.equal(await anvil.publicClient.getChainId(), 84532);
    assert.equal(Object.keys(anvil.accounts).length, 10);
    const manifest = ProtocolDeployment.parse(await deployAlphaProtocol(anvil));
    assert.equal(manifest.params.replayAllowed, true);
    for (const address of Object.values(manifest.shared))
      assert.notEqual(
        await anvil.publicClient.getCode({ address: address as `0x${string}` }),
        undefined,
      );

    const height = await anvil.publicClient.getBlockNumber();
    const snapshot = await anvil.snapshot();
    await anvil.mine(3);
    assert.equal(await anvil.publicClient.getBlockNumber(), height + 3n);
    await anvil.revert(snapshot);
    assert.equal(await anvil.publicClient.getBlockNumber(), height);
    await assert.rejects(anvil.revert(snapshot), /ANVIL_REVERT_FAILED/);

    const target = (await anvil.publicClient.getBlock()).timestamp + 1000n;
    await anvil.setNextTimestamp(target);
    await anvil.mine();
    assert.equal((await anvil.publicClient.getBlock()).timestamp, target);
  } finally {
    await anvil.stop();
  }
  await assert.rejects(anvil.publicClient.getChainId(), "node is gone");
  await anvil.stop();
});
