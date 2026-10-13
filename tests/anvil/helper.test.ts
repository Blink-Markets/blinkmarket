import { test } from "node:test";
import assert from "node:assert/strict";
import { DeploymentManifest } from "../../packages/schemas/src/index.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../../packages/adapters/src/blink-abi.js";
import { deployBlink, startAnvil } from "../helpers/anvil.js";

test("startAnvil and deployBlink give a valid manifest, working snapshots and a clean stop", async () => {
  const anvil = await startAnvil();
  try {
    assert.equal(anvil.chainId, 84532);
    assert.equal(await anvil.publicClient.getChainId(), 84532);
    assert.equal(Object.keys(anvil.accounts).length, 10);
    const deployed = await deployBlink(anvil);
    const manifest = DeploymentManifest.parse(deployed.manifest);
    assert.equal(manifest.tradingEnabled, true);
    assert.equal(manifest.contracts.BlinkMarket, deployed.market);
    assert.equal(manifest.contracts.BlinkTestUSD, deployed.token);
    assert.equal(manifest.deploymentBlock, String(deployed.deploymentBlock));
    for (const address of [deployed.market, deployed.token])
      assert.notEqual(
        await anvil.publicClient.getCode({ address }),
        undefined,
        "contract has code",
      );
    // The shared ABI module reads the real contracts.
    assert.equal(
      await anvil.publicClient.readContract({
        address: deployed.market,
        abi: blinkMarketAbi,
        functionName: "maker",
      }),
      anvil.accounts.maker.address,
    );
    assert.equal(
      await anvil.publicClient.readContract({
        address: deployed.token,
        abi: blinkTestUsdAbi,
        functionName: "minter",
      }),
      anvil.accounts.minter.address,
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
