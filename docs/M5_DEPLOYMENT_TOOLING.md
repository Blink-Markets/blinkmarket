# M5 preparation — contract deployment tooling

This slice adds a guarded deployer that puts `BlinkTestUSD` and `BlinkMarket` on a chain, produces a release manifest, and verifies that manifest with the existing `verifyDeploymentOnChain` before it writes anything. It is **tooling only**. It has been exercised against local Anvil started with `--chain-id 84532`; nothing has been deployed to Base Sepolia or any other public network, and no real role wallet, RPC provider or key was used.

中文摘要：新增受保護的合約部署工具，部署 BlinkTestUSD 與 BlinkMarket、產生並用既有 verifier 驗證 release manifest；目前只在本機 Anvil（chain ID 84532）驗證，尚未部署到任何公開網路。

## What the tool does

| Piece | Where |
| --- | --- |
| Planner and deployer | `packages/adapters/src/contract-deployer.ts` (`planDeployment`, `deployContracts`, `readReleaseCommit`) |
| Operator command | `pnpm contracts:deploy` (`scripts/deploy-contracts.ts`) |
| Tests | `pnpm test:anvil` (`tests/anvil/deploy-contracts.test.ts`) |

Guards, in the order they run:

1. The RPC chain ID must be 84532. 8453 fails with `MAINNET_REFUSED` and any other ID fails with `WRONG_CHAIN`. The check runs before the private key is read and again right before each of the two broadcasts. No environment variable bypasses it.
2. The six roles (`admin`, `resultProposer`, `challenger`, `arbiter`, `maker`, `faucetMinter`) must be non-zero and pairwise distinct (case-insensitive), the same rules as `DeploymentManifest`. The deployer address must not equal any of them, so the deployer never holds a protocol role.
3. The deployment ID must match the `DeploymentId` schema, and the commit and dependency list must produce a schema-valid manifest. This is dry-parsed with the predicted contract addresses before any gas is spent. Both constructors' arguments must also encode (`INVALID_CONSTRUCTOR_ARGS`, for example a mixed-case address with a bad checksum), and the maker must have no contract code (`MAKER_HAS_CODE`, which the BlinkMarket constructor would otherwise enforce after the token is on chain). The dry run runs the same checks.
4. The artifacts in `contracts/artifacts/` must be internally consistent: the ABI hash, the creation bytecode hash and the `0.8.30` compiler recorded by `pnpm check:contracts` must match the file contents (`ARTIFACT_MISMATCH` otherwise).
5. The git tree must be clean (`DIRTY_TREE`) unless `--allow-dirty` is passed. The manifest's `gitCommit` is `git rev-parse HEAD`.
6. `--out <file>` must not exist (`OUTPUT_EXISTS`) and its directory must exist. It is checked before the chain, the key or any transaction. The file is created exclusively, so an existing file is never overwritten.

Deployment order is `BlinkTestUSD(faucetMinter)` then `BlinkMarket(token, maker, admin, resultProposer, challenger, arbiter)`, each waiting for a successful receipt. The manifest then records:

- `deploymentBlock`: the smaller of the two receipt block numbers (an inclusive replay lower bound).
- `abiHashes`: from the artifacts. `bytecodeHashes`: the keccak256 of the **runtime code read back from the chain**, which is what `verifyDeploymentOnChain` compares. The dry-run plan prints the artifacts' ABI hashes and **creation** bytecode hashes instead, because the runtime code depends on constructor immutables and the deployment address, so it is only known after deployment.
- `dependencies`: the `@openzeppelin/contracts`, `solc` and `viem` versions from the root `package.json` `devDependencies`.
- `tradingEnabled: false`, always.

If on-chain verification fails, **no manifest file is written** and the command exits non-zero. The error names any contracts already on chain, because transactions cannot be undone. The tool never calls `setTakerAllowed`, `depositMaker` or market creation.

## Operator runbook (for a later, separately authorized Base Sepolia run)

Running this against a public network needs the project owner's explicit authorization. Source-control authorization in `AGENTS.md` does not cover deployment, paid services or signing. Replace every `<PLACEHOLDER>`; none of the values below exist yet.

1. **Choose the roles.** Six distinct externally owned addresses: `<ADMIN_ADDRESS>`, `<RESULT_PROPOSER_ADDRESS>`, `<CHALLENGER_ADDRESS>`, `<ARBITER_ADDRESS>`, `<MAKER_ADDRESS>`, `<FAUCET_MINTER_ADDRESS>`. The `<MAKER_ADDRESS>` must have no contract code (the contract rejects it). A separate deployer account `<DEPLOYER_ADDRESS>` must hold none of those roles.
2. **Prepare a clean checkout** of the exact commit to release, with no uncommitted or untracked files:
   ```sh
   pnpm install --frozen-lockfile
   pnpm check:contracts
   ```
   The deployer does not recompile. Rebuild the artifacts on this commit so the recorded hashes describe the committed sources.
3. **Fund the deployer** `<DEPLOYER_ADDRESS>` with Base Sepolia test ETH from a source of your choice. The dry run prints its balance.
4. **Dry run.** This reads no key and sends nothing:
   ```sh
   DEPLOY_RPC_URL=<DEPLOY_RPC_URL> pnpm contracts:deploy \
     --deployment-id <DEPLOYMENT_ID> \
     --admin <ADMIN_ADDRESS> --result-proposer <RESULT_PROPOSER_ADDRESS> \
     --challenger <CHALLENGER_ADDRESS> --arbiter <ARBITER_ADDRESS> \
     --maker <MAKER_ADDRESS> --faucet-minter <FAUCET_MINTER_ADDRESS> \
     --deployer <DEPLOYER_ADDRESS>
   ```
   Check that `chainId` is 84532, `gitCommit` is the intended commit, the balance is non-zero, the constructor arguments carry the intended roles, and the ABI and creation hashes are the ones you expect. Use a new `<DEPLOYMENT_ID>` for every deployment.
5. **Broadcast.** The key is `0x` plus 64 hex characters and is never printed. Read it into the environment without putting it on a command line, so it stays out of shell history and process listings (paste it at the silent prompt), and remove it afterwards:
   ```sh
   read -rs DEPLOYER_PRIVATE_KEY && export DEPLOYER_PRIVATE_KEY
   DEPLOY_RPC_URL=<DEPLOY_RPC_URL> \
   pnpm contracts:deploy <same role and deployment flags> --broadcast --out <MANIFEST_PATH>
   unset DEPLOYER_PRIVATE_KEY
   ```
   `--out` is required with `--broadcast`. `--deployer` is optional here, and if given it must match the key. If the manifest file cannot be written after a successful, verified deployment, the command prints the full manifest JSON on stdout and exits non-zero (`MANIFEST_WRITE_FAILED`); save that output before doing anything else.
6. **Verify independently**, from a second look at the chain:
   ```sh
   BASE_SEPOLIA_RPC_URL=<DEPLOY_RPC_URL> pnpm manifest:verify <MANIFEST_PATH> <DEPLOYMENT_ID>
   ```
7. **Register** the manifest where the platform reads it, using the existing registration command:
   ```sh
   DEPLOYMENT_ADMIN_DATABASE_URL=<DEPLOYMENT_ADMIN_DATABASE_URL> BASE_SEPOLIA_RPC_URL=<DEPLOY_RPC_URL> \
   pnpm deployment:register <MANIFEST_PATH> <DEPLOYMENT_ID> "<REASON>"
   ```
8. **Human follow-ups, outside this tool:** allowlisting takers (`setTakerAllowed`), the maker's collateral deposit (`depositMaker`), creating markets, and any decision to enable trading.

### Errors

| Code | Meaning |
| --- | --- |
| `MAINNET_REFUSED` / `WRONG_CHAIN` | RPC reports 8453 / any ID other than 84532. Nothing was sent. |
| `INVALID_ROLES`, `ROLES_NOT_DISTINCT`, `DEPLOYER_HOLDS_ROLE` | Role rules above. |
| `INVALID_DEPLOYMENT_ID`, `INVALID_DEPLOYMENT_INPUT` | The ID, commit or dependency list would not make a valid manifest. |
| `INVALID_CONSTRUCTOR_ARGS`, `MAKER_HAS_CODE` | A constructor argument does not encode (such as a bad-checksum address), or the maker is a contract. Found before any transaction. |
| `ARTIFACT_MISMATCH` | Artifacts are stale or edited; run `pnpm check:contracts`. |
| `DIRTY_TREE` | Uncommitted or untracked files; commit them or pass `--allow-dirty` for a non-release run. |
| `OUTPUT_EXISTS`, `OUTPUT_REQUIRED`, `OUTPUT_DIRECTORY_MISSING` | `--out` problems, found before any transaction. |
| `DEPLOYER_KEY_INVALID`, `DEPLOYER_MISMATCH` | The key is malformed or outside the secp256k1 range (a fixed message that never echoes the value), or `--deployer` is not the key's address. |
| `MANIFEST_WRITE_FAILED` | The deployment verified but the file could not be written; the manifest is on stdout. |
| `DEPLOY_TX_REVERTED` | A deployment transaction reverted on chain. |
| `DEPLOY_GAS_ESTIMATE_FAILED` | The read-only gas estimate for a contract failed on every attempt; that contract was not sent. |
| `DEPLOYMENT_VERIFICATION_FAILED` | Contracts were deployed but the retried verification did not succeed. No file was written. |

Gas estimates and reads after a receipt are retried (30 × 1 s) because a load-balanced RPC can answer from a node that has not seen the latest block. Gas and nonces are set explicitly; sends are never retried.

An error ending in `(already deployed: ...)` lists contracts that are on chain but have no manifest. They are not part of any deployment: fix the cause and run again with a **new** `<DEPLOYMENT_ID>`.

## Verification

Run on 2026-10-20 against local Anvil only (chain ID 84532, the public test mnemonic).

| Command | Result |
| --- | --- |
| `pnpm test:anvil` | 54 tests passed |
| `pnpm check` | passed: typecheck, 697 Node tests, package boundaries, contract compile |
| `pnpm build:services && pnpm test:service-build` | passed: 6 tests |

The Anvil tests cover: a deployment on 84532 whose manifest parses, verifies and has code at both addresses with exactly two transactions sent; the plan's predicted token address matching the real deployment; `MAINNET_REFUSED` (chain 8453) and `WRONG_CHAIN` (chain 31337) with the deployer's nonce and the block number unchanged; a dry run that sends nothing; duplicate, zero, malformed, bad-checksum and deployer-held roles, and a maker that has code, all rejected with no transaction sent; invalid deployment ID, commit and dependencies; a tampered artifact; a failed verification (simulated head-hash change) naming what is on chain; the chain re-check before each broadcast (the RPC flips to 8453 before the token or before the market, and the market is never sent); `readReleaseCommit` on a temporary repository; and the CLI for the dry run (key unread), a broadcast that writes a verifying manifest once and never prints the key, `OUTPUT_EXISTS`, the chain check running before the key is read, `DEPLOYER_MISMATCH`, an out-of-range key that is never echoed, and a manifest write failure that prints the verified manifest.

## Open items and limits

- **Not run on Base Sepolia.** The real run needs the owner's authorization, real role wallets, a funded deployer and an RPC provider. None exist yet.
- **Stale artifacts are only detected when inconsistent.** The tool cannot tell that `contracts/artifacts/` was built from different sources than `HEAD`; the runbook step 2 is the control. A freshness check (rebuild, or compare source hashes) is not implemented.
- **Verification can still exhaust its retries.** A load-balanced RPC provider that remains behind for 30 seconds can fail the check although the contracts are fine. There is no resume mode that builds a manifest from existing addresses; today the recovery is a new deployment ID.
- **`gitCommit` does not by itself bind the deployed bytecode.** The manifest's `bytecodeHashes` are read back from the chain after deployment, and `contracts/artifacts/` is git-ignored, so nothing in the repository proves that the deployed code was built from the recorded commit. A reproducible-build check (rebuild from the commit and compare the creation bytecode hash) is not implemented.
- **The deployer key comes from an environment variable.** Same-user processes can read it. Loading from a mode 0600 file, a hardware wallet or a secret manager is not implemented.
