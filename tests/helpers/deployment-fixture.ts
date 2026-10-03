import { keccak256, toBytes, type PublicClient } from "viem";
// Deterministic mock RPC only. Never represents a real Base Sepolia deployment.
export function deploymentFixture() {
  const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  const code = "0x6000" as const;
  const manifest = {
    status: "DEPLOYED",
    deploymentId: "test",
    chainId: 84532,
    deploymentBlock: "1",
    contracts: { BlinkMarket: address(10), BlinkTestUSD: address(11) },
    roles: {
      admin: address(1),
      resultProposer: address(2),
      challenger: address(3),
      arbiter: address(4),
      maker: address(5),
      faucetMinter: address(6),
    },
    artifacts: {
      abiHashes: {
        BlinkMarket: keccak256(toBytes("[]")),
        BlinkTestUSD: keccak256(toBytes("[]")),
      },
      bytecodeHashes: {
        BlinkMarket: keccak256(code),
        BlinkTestUSD: keccak256(code),
      },
      compiler: "0.8.30",
      gitCommit: "1".repeat(40),
      dependencies: { openzeppelin: "5.6.1" },
    },
    parameters: {
      collateralDecimals: 6,
      quoteDefaultTtlSeconds: 30,
      quoteMaxTtlSeconds: 60,
      makerSpreadBps: 200,
      maxFillShares: "100",
      maxMarketPairs: "10000",
      maxTakerShares: "500",
    },
    tradingEnabled: false,
  };
  const blockHash = keccak256(toBytes("fixture block"));
  const client = {
    async getChainId() {
      return 84532;
    },
    async getBlock() {
      return { number: 10n, hash: blockHash };
    },
    async getCode({ blockNumber }: { blockNumber: bigint }) {
      return blockNumber === 0n ? "0x" : code;
    },
    async readContract({ functionName }: { functionName: string }) {
      return (
        {
          collateral: manifest.contracts.BlinkTestUSD,
          ...manifest.roles,
          minter: manifest.roles.faucetMinter,
          decimals: 6,
          symbol: "bUSD",
          name: "Blink Test USD",
          MAX_FILL_SHARES: 100n,
          MAX_MARKET_PAIRS: 10000n,
          MAX_TAKER_SHARES: 500n,
        } as Record<string, unknown>
      )[functionName];
    },
  } as unknown as PublicClient;
  return { manifest, client, abis: { BlinkMarket: [], BlinkTestUSD: [] } };
}
