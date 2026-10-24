import { readFileSync } from "node:fs";
import solc from "solc";
import {
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  getContractAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

// MockErc1271Wallet comes from contracts/test and is not part of contracts/artifacts, so the
// anvil tests compile it (and a minimal CREATE2 factory for ERC-6492) in memory.
const MOCK_PATH = "contracts/test/protocol/MockErc1271Wallet.sol";
const FACTORY_SOURCE = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
contract Create2Factory {
    function deploy(bytes32 salt, bytes memory initcode) external returns (address a) {
        assembly ("memory-safe") { a := create2(0, add(initcode, 0x20), mload(initcode), salt) }
        require(a != address(0), "create2 failed");
    }
}`;
const factoryAbi = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "salt", type: "bytes32" },
      { name: "initcode", type: "bytes" },
    ],
    outputs: [{ name: "a", type: "address" }],
  },
] as const satisfies Abi;

type Compiled = { abi: Abi; bytecode: Hex };
let cache: { wallet: Compiled; factory: Compiled } | undefined;

function compile(): { wallet: Compiled; factory: Compiled } {
  if (cache) return cache;
  const input = {
    language: "Solidity",
    sources: {
      [MOCK_PATH]: { content: readFileSync(MOCK_PATH, "utf8") },
      "Create2Factory.sol": { content: FACTORY_SOURCE },
    },
    settings: {
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (path: string) => {
        try {
          return {
            contents: readFileSync(
              path.startsWith("@") ? "node_modules/" + path : path,
              "utf8",
            ),
          };
        } catch {
          return { error: "Import not found: " + path };
        }
      },
    }),
  );
  const errors = (output.errors ?? []).filter(
    (e: { severity: string }) => e.severity === "error",
  );
  if (errors.length) throw new Error(errors[0].formattedMessage);
  const pick = (file: string, name: string): Compiled => {
    const c = output.contracts[file][name];
    return { abi: c.abi, bytecode: ("0x" + c.evm.bytecode.object) as Hex };
  };
  return (cache = {
    wallet: pick(MOCK_PATH, "MockErc1271Wallet"),
    factory: pick("Create2Factory.sol", "Create2Factory"),
  });
}

export const contractWalletArtifacts = () => compile();

/** Initcode of a MockErc1271Wallet owned by `owner`. */
export function walletInitcode(owner: Address): Hex {
  const { wallet } = compile();
  return encodeDeployData({
    abi: wallet.abi,
    bytecode: wallet.bytecode,
    args: [owner],
  });
}

/** Where `factory.deploy(salt, walletInitcode(owner))` will put the wallet, and the ERC-6492 factory call. */
export function counterfactualWallet(
  factory: Address,
  owner: Address,
  salt: Hex,
) {
  const initcode = walletInitcode(owner);
  return {
    address: getContractAddress({
      opcode: "CREATE2",
      from: factory,
      salt,
      bytecode: initcode,
    }),
    factoryData: encodeFunctionData({
      abi: factoryAbi,
      functionName: "deploy",
      args: [salt, initcode],
    }),
  };
}

// Kept for tests that need the raw encoding of a salt.
export const saltOf = (n: number): Hex =>
  encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]);
