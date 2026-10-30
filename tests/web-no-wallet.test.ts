import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

test("the website depends on no wallet or chain library", () => {
  const pkg = JSON.parse(readFileSync("apps/web/package.json", "utf8"));
  const forbidden = /^(viem|wagmi|ethers|web3|@rainbow-me\/rainbowkit|connectkit|@reown\/.*|@web3modal\/.*|@walletconnect\/.*|@coinbase\/wallet-sdk|@metamask\/.*)$/;
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) assert.doesNotMatch(name, forbidden);
});

test("no website source asks for a wallet, a signature or a transaction", () => {
  const forbidden = /window\.ethereum|eth_requestAccounts|eth_sendTransaction|personal_sign|eth_signTypedData|signTypedData|sendTransaction|writeContract/;
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !["node_modules", ".next", "out"].includes(entry.name)) scan(join(dir, entry.name));
      else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) assert.doesNotMatch(readFileSync(join(dir, entry.name), "utf8"), forbidden, join(dir, entry.name));
    }
  }
  scan("apps/web");
});

test("no protocol contract has an owner, admin, pause or upgrade function", () => {
  for (const file of readdirSync("contracts/src/protocol").filter((f) => f.endsWith(".sol"))) {
    const source = readFileSync(`contracts/src/protocol/${file}`, "utf8");
    if (!/\bcontract\s+\w+/.test(source)) continue;
    const abi = JSON.parse(readFileSync(`contracts/artifacts/${file.replace(/\.sol$/, ".json")}`, "utf8")).abi;
    for (const item of abi) if (item.type === "function") assert.doesNotMatch(item.name, /owner|admin|pause|upgrade|rescue|sweep|emergency/i, file);
  }
});
