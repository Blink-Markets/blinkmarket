import solc from "solc";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { keccak256, toBytes } from "viem";
const EIP170_MAX_RUNTIME_BYTES = 24_576;
for (const name of ["BlinkMarket", "IBlinkMarket"])
  rmSync(`contracts/artifacts/${name}.json`, { force: true });
const protocolDir = "contracts/src/protocol";
const paths = [
  "contracts/src/BlinkTestUSD.sol",
  ...readdirSync(protocolDir, { recursive: true })
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".sol"))
    .sort()
    .map((f) => protocolDir + "/" + f),
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
        "*": [
          "abi",
          "evm.bytecode.object",
          "evm.deployedBytecode.object",
          "evm.deployedBytecode.immutableReferences",
        ],
        // The AST names the immutables that the compiler reports only by node id.
        "": ["ast"],
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
// AST node id -> "Declaring.name" for every immutable, including those of imported bases.
const immutableNames = new Map();
const collectImmutables = (node, contract) => {
  if (Array.isArray(node))
    return node.forEach((n) => collectImmutables(n, contract));
  if (!node || typeof node !== "object") return;
  if (node.nodeType === "ContractDefinition") contract = node.name;
  if (
    node.nodeType === "VariableDeclaration" &&
    node.mutability === "immutable"
  )
    immutableNames.set(node.id, contract + "." + node.name);
  for (const child of Object.values(node)) collectImmutables(child, contract);
};
for (const source of Object.values(output.sources ?? {}))
  collectImmutables(source.ast);
mkdirSync("contracts/artifacts", { recursive: true });
let oversize = false;
for (const path of paths) {
  for (const [name, c] of Object.entries(output.contracts[path] ?? {})) {
    const runtimeBytes = c.evm.deployedBytecode.object.length / 2;
    if (runtimeBytes > EIP170_MAX_RUNTIME_BYTES) {
      console.error(
        name + ": runtime " + runtimeBytes + " bytes exceeds EIP-170",
      );
      oversize = true;
    }
    // Where the runtime holds each immutable: { "Contract.name": [{ start, length }] }.
    const immutableReferences = Object.fromEntries(
      Object.entries(c.evm.deployedBytecode.immutableReferences ?? {}).map(
        ([id, refs]) => {
          const name = immutableNames.get(Number(id));
          if (!name) throw new Error(name + ": unnamed immutable " + id);
          return [name, refs];
        },
      ),
    );
    const artifact = {
      contractName: name,
      compiler: solc.version(),
      evmVersion: "cancun",
      abi: c.abi,
      abiHash: keccak256(toBytes(JSON.stringify(c.abi))),
      bytecode: "0x" + c.evm.bytecode.object,
      deployedBytecodeTemplate: "0x" + c.evm.deployedBytecode.object,
      immutableReferences,
    };
    artifact.creationBytecodeHash = keccak256(artifact.bytecode);
    // write then rename so tests reading artifacts in parallel never see a partial file
    const file = "contracts/artifacts/" + name + ".json";
    writeFileSync(file + ".tmp", JSON.stringify(artifact, null, 2) + "\n");
    renameSync(file + ".tmp", file);
    console.log(name + ": compiled; ABI hash " + artifact.abiHash);
  }
}
if (oversize) process.exit(1);
