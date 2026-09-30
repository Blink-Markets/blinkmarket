import solc from "solc";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { keccak256, toBytes } from "viem";
const paths = [
  "contracts/src/BlinkMarket.sol",
  "contracts/src/BlinkTestUSD.sol",
];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(
    paths.map((p) => [p, { content: readFileSync(p, "utf8") }]),
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "cancun",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};
const output = JSON.parse(
  solc.compile(JSON.stringify(input), {
    import: (p) => {
      try {
        return {
          contents: readFileSync(
            p.startsWith("@") ? "node_modules/" + p : p,
            "utf8",
          ),
        };
      } catch {
        return { error: "Import not found: " + p };
      }
    },
  }),
);
for (const error of output.errors ?? []) console.error(error.formattedMessage);
if ((output.errors ?? []).some((e) => e.severity === "error")) process.exit(1);
mkdirSync("contracts/artifacts", { recursive: true });
for (const path of paths) {
  const name = path.split("/").at(-1).replace(".sol", "");
  const c = output.contracts[path][name];
  const artifact = {
    contractName: name,
    compiler: solc.version(),
    evmVersion: "cancun",
    abi: c.abi,
    abiHash: keccak256(toBytes(JSON.stringify(c.abi))),
    bytecode: "0x" + c.evm.bytecode.object,
    deployedBytecodeTemplate: "0x" + c.evm.deployedBytecode.object,
  };
  artifact.creationBytecodeHash = keccak256(artifact.bytecode);
  writeFileSync(
    "contracts/artifacts/" + name + ".json",
    JSON.stringify(artifact, null, 2) + "\n",
  );
  console.log(name + ": compiled; ABI hash " + artifact.abiHash);
}
