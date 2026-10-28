import { startAlphaPlatform } from "./alpha/platform.ts";

// Starts the pglite local alpha platform and keeps it up until SIGINT or SIGTERM, for the optional
// LLM agent demo (examples/llm-agent). The funded account is Anvil's public test account at index 7
// of the well-known mnemonic "test test test test test test test test test test test junk"; its
// key is public, so only the address is printed.
const platform = await startAlphaPlatform({ backend: "pglite" });
console.log(`BLINK_API_URL=${platform.apiUrl}`);
console.log(`BLINK_RPC_URL=${platform.rpcUrl}`);
console.log(`FUNDED_TEST_ACCOUNT=${platform.accounts.taker2.address} (Anvil test account index 7)`);
console.log("READY");

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  try {
    await platform.stop();
    process.exit(0);
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// Keep the event loop alive even if the platform holds no handle of its own.
setInterval(() => undefined, 2 ** 30);
